import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DriveService } from './drive.service';
import { environment } from '../../../../environments/environment';

describe('DriveService', () => {
  let service: DriveService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        DriveService
      ]
    });
    service = TestBed.inject(DriveService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should get quota', () => {
    service.getQuota().subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/users/me/quota`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('should get tree', () => {
    service.getTree().subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/tree`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('creates folder trees in one opaque batch request', () => {
    const folders = [{ client_ref: 'ref-1', parent_client_ref: null, encrypted_name: 'cipher', name_hash: 'hash' }];
    service.batchCreateFolders(7, folders).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/folders/batch-create`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ root_parent_id: 7, folders });
    expect(JSON.stringify(req.request.body)).not.toContain('path');
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ folders: [{ client_ref: 'ref-1', folder_id: 8, created: true }] });
  });

  it('should manage pinned folders using only ids and credentials', () => {
    service.getPinnedFolders().subscribe();
    let req = httpMock.expectOne(`${environment.apiUrl}/folders/pinned`);
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ folders: [] });

    service.pinFolder(7).subscribe();
    req = httpMock.expectOne(`${environment.apiUrl}/folders/7/pin`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toBeNull();
    expect(req.request.withCredentials).toBeTrue();
    req.flush(null);

    service.unpinFolder(7).subscribe();
    req = httpMock.expectOne(`${environment.apiUrl}/folders/7/pin`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.withCredentials).toBeTrue();
    req.flush(null);

    service.reorderPinnedFolders([9, 7]).subscribe();
    req = httpMock.expectOne(`${environment.apiUrl}/folders/pinned/order`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ folder_ids: [9, 7] });
    expect(req.request.withCredentials).toBeTrue();
    expect(JSON.stringify(req.request.body)).not.toContain('name');
    expect(JSON.stringify(req.request.body)).not.toContain('path');
    req.flush(null);
  });

  it('should propagate pinned-folder HTTP errors', () => {
    let error: unknown;
    service.getPinnedFolders().subscribe({ error: value => error = value });
    const req = httpMock.expectOne(`${environment.apiUrl}/folders/pinned`);
    req.flush({}, { status: 401, statusText: 'Unauthorized' });
    expect((error as any).status).toBe(401);
  });

  it('should create folder', () => {
    service.createFolder('enc_name', 'hash', 10).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/folders`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      encrypted_name: 'enc_name',
      name_hash: 'hash',
      parent_id: 10
    });
    req.flush({});
  });

  it('should init file upload', () => {
    service.initFileUpload(5, 'enc_file', 'hash', 'fdk', 100, 2).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      folder_id: 5,
      encrypted_name: 'enc_file',
      name_hash: 'hash',
      encrypted_fdk: 'fdk',
      size_bytes: 100,
      total_chunks: 2,
      storage_provider: 'local',
      is_hidden: false
    });
    req.flush({});
  });

  it('should upload chunk', () => {
    const blob = new Blob(['chunk']);
    service.uploadChunk(100, 0, blob).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/chunks`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('X-Chunk-Index')).toBe('0');
    expect(req.request.body).toBe(blob);
    req.flush(null);
  });

  it('should get uploaded chunks', () => {
    service.getUploadedChunks(100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/uploaded-chunks`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('should get pending uploads', () => {
    service.getPendingUploads().subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/pending-uploads`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('should download file', () => {
    service.downloadFile(100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/download`);
    expect(req.request.method).toBe('GET');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob());
  });

  it('should download file range', () => {
    service.downloadFileRange(100, 0, 500).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/download`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Range')).toBe('bytes=0-500');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob());
  });

  it('should trash file', () => {
    service.trashFile(100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('should hard delete file', () => {
    service.hardDeleteFile(100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/trash/files/100`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('should update file', () => {
    service.updateFile(100, { encrypted_name: 'new_name' }).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ encrypted_name: 'new_name' });
    req.flush({});
  });

  it('should update folder', () => {
    service.updateFolder(50, { parent_id: 10 }).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/folders/50`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ parent_id: 10 });
    req.flush({});
  });

  it('should create share link and map response', () => {
    let result: any;
    service.createShareLink(100, 'fdk_enc').subscribe(res => result = res);
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/share`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ encrypted_name_fdk: 'fdk_enc' });
    req.flush({ share_uuid: 'uuid-123' });
    
    expect(result).toEqual({ share_id: 'uuid-123' });
  });

  it('should create share link without fdk', () => {
    service.createShareLink(100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/share`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ share_uuid: 'uuid-123' });
  });
  
  it('should get linked google accounts', () => {
    service.getLinkedGoogleAccounts().subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/api/storage/google/accounts`);
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('should unlink google account', () => {
    service.unlinkGoogleAccount(1).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/api/storage/google/accounts/1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({});
  });

  it('should generate google state', () => {
    service.generateGoogleState().subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/api/storage/google/generate-state`);
    expect(req.request.method).toBe('GET');
    req.flush({ state: 'random_state' });
  });

  it('should finalize external upload', () => {
    service.finalizeExternalUpload(1, 'ext-id').subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/1/finalize-external`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ external_file_id: 'ext-id' });
    req.flush({});
  });

  it('should initialize a bounded encrypted batch without plaintext fields', () => {
    service.batchInitUploads([
      {
        folder_id: null,
        encrypted_name: 'enc-name',
        name_hash: 'hash-name',
        encrypted_fdk: 'enc-fdk',
        size_bytes: 10,
        total_chunks: 1,
        storage_provider: 'local',
      },
      {
        folder_id: 7,
        encrypted_name: 'enc-google-name',
        name_hash: 'hash-google-name',
        encrypted_fdk: 'enc-google-fdk',
        size_bytes: 20,
        total_chunks: 1,
        storage_provider: 'google_drive',
      },
    ]).subscribe();

    const req = httpMock.expectOne(`${environment.apiUrl}/files/batch-init`);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.body.files).toHaveSize(2);
    expect(JSON.stringify(req.request.body)).not.toContain('original.txt');
    expect(JSON.stringify(req.request.body)).not.toContain('webkitRelativePath');
    req.flush({ files: [] });
  });

  it('should download external metadata', () => {
    service.downloadExternalMetadata(1).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/1/download`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('should download external file', () => {
    service.downloadExternalFile('http://example.com/file', 'token').subscribe();
    const req = httpMock.expectOne('http://example.com/file');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe('Bearer token');
    req.flush(new Blob());
  });

  it('should download external file range', () => {
    service.downloadExternalFileRange('http://example.com/file', 'token', 0, 100).subscribe();
    const req = httpMock.expectOne('http://example.com/file');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe('Bearer token');
    expect(req.request.headers.get('Range')).toBe('bytes=0-100');
    req.flush(new Blob());
  });

  it('should batch soft delete files', () => {
    service.batchSoftDeleteFiles([1, 2]).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/batch-delete`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ file_ids: [1, 2] });
    req.flush({});
  });

  it('should batch hard delete files', () => {
    service.batchHardDeleteFiles([1, 2]).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/trash/files/batch-delete`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ file_ids: [1, 2] });
    req.flush({});
  });

  it('should trash folder', () => {
    service.trashFolder(1).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/folders/1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({});
  });

  it('should batch soft delete folders', () => {
    service.batchSoftDeleteFolders([1, 2]).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/folders/batch-delete`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ folder_ids: [1, 2] });
    req.flush({});
  });

  it('should get trash', () => {
    service.getTrash().subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/trash`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('should restore file', () => {
    service.restoreFile(1).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/1/restore`);
    expect(req.request.method).toBe('POST');
    req.flush({});
  });

  it('should restore folder', () => {
    service.restoreFolder(1).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/folders/1/restore`);
    expect(req.request.method).toBe('POST');
    req.flush({});
  });

  it('should hard delete folder', () => {
    service.hardDeleteFolder(1).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/trash/folders/1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({});
  });

  it('should batch hard delete folders', () => {
    service.batchHardDeleteFolders([1, 2]).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/trash/folders/batch-delete`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ folder_ids: [1, 2] });
    req.flush({});
  });

  it('should empty trash', () => {
    service.emptyTrash().subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/trash/empty`);
    expect(req.request.method).toBe('DELETE');
    req.flush({});
  });

  it('should list shares', () => {
    service.listShares(1).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/1/shares`);
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('should revoke share', () => {
    service.revokeShare('share-123').subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/shares/share-123`);
    expect(req.request.method).toBe('DELETE');
    req.flush({});
  });
});
