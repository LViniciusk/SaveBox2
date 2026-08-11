import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DriveService } from './drive.service';
import { environment } from '../../../../environments/environment';
import { DRIVE_TRANSFER_CHUNK_SIZE } from '../transfer-limits';
import { firstValueFromAbortable } from '../upload/abortable-observable';

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

  it('should request a tree page when pagination is provided', () => {
    service.getTree(100, 200).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/tree?file_limit=100&file_offset=200`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('requests folders explicitly only when requested by a paginated caller', () => {
    (service.getTree as any)(100, 200, false).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/tree?file_limit=100&file_offset=200&include_folders=false`);
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

  it('resolves a real HttpClient void chunk response through firstValueFromAbortable', async () => {
    const blob = new Blob(['chunk']);
    const result = firstValueFromAbortable(service.uploadChunk(100, 1, blob));
    const req = httpMock.expectOne(`${environment.uploadApiUrl}/files/100/chunks`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('X-Chunk-Index')).toBe('1');
    expect(req.request.body).toBe(blob);
    expect(req.request.withCredentials).toBeTrue();
    req.flush(null);

    await expectAsync(result).toBeResolved();
  });

  it('rejects a real HttpClient chunk error', async () => {
    const result = firstValueFromAbortable(service.uploadChunk(100, 1, new Blob(['chunk'])));
    const req = httpMock.expectOne(`${environment.uploadApiUrl}/files/100/chunks`);
    req.flush({}, { status: 500, statusText: 'Internal Server Error' });

    let rejectedWithHttpError = false;
    await result.catch(error => rejectedWithHttpError = error.status === 500);
    expect(rejectedWithHttpError).toBeTrue();
  });

  it('aborts and unsubscribes a real HttpClient chunk request', async () => {
    const controller = new AbortController();
    const result = firstValueFromAbortable(
      service.uploadChunk(100, 1, new Blob(['chunk'])),
      controller.signal,
    );
    const req = httpMock.expectOne(`${environment.uploadApiUrl}/files/100/chunks`);
    controller.abort();

    await expectAsync(result).toBeRejectedWithError('Upload cancelled');
    expect(req.cancelled).toBeTrue();
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

  it('should download a pending local recovery prefix with an exact 206 response', () => {
    const blob = new Blob(['cipher-prefix']);
    let result: Blob | undefined;
    service.downloadPendingUploadRecoveryPrefix(100, 131071).subscribe(value => result = value);
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/pending-upload-recovery-prefix`);
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.headers.get('Range')).toBe('bytes=0-131071');
    expect(req.request.body).toBeNull();
    req.flush(blob, { status: 206, statusText: 'Partial Content' });
    expect(result).toBe(blob);
  });

  it('rejects invalid pending recovery prefix ends', () => {
    for (const end of [-1, DRIVE_TRANSFER_CHUNK_SIZE, 1.5]) {
      expect(() => service.downloadPendingUploadRecoveryPrefix(100, end)).toThrowError('Range de recovery inválido');
    }
  });

  it('rejects a non-partial pending recovery response', () => {
    let error: Error | undefined;
    service.downloadPendingUploadRecoveryPrefix(100, 31).subscribe({ error: value => error = value });
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/pending-upload-recovery-prefix`);
    req.flush(new Blob(['unexpected']), { status: 200, statusText: 'OK' });
    expect(error?.message).toBe('Resposta de recovery inválida');
  });

  it('should download a preview using sequential Range requests', async () => {
    const promise = service.downloadFileInRanges(100, DRIVE_TRANSFER_CHUNK_SIZE + 1);
    await Promise.resolve();

    const first = httpMock.expectOne(`${environment.apiUrl}/files/100/download`);
    expect(first.request.headers.get('Range')).toBe(`bytes=0-${DRIVE_TRANSFER_CHUNK_SIZE - 1}`);
    first.flush(new Blob(['first']));
    await Promise.resolve();

    const second = httpMock.expectOne(`${environment.apiUrl}/files/100/download`);
    expect(second.request.headers.get('Range')).toBe(`bytes=${DRIVE_TRANSFER_CHUNK_SIZE}-${DRIVE_TRANSFER_CHUNK_SIZE}`);
    second.flush(new Blob(['second']));

    expect((await promise).size).toBe(11);
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
        client_ref: 'local-ref',
        folder_id: null,
        encrypted_name: 'enc-name',
        name_hash: 'hash-name',
        encrypted_fdk: 'enc-fdk',
        size_bytes: 10,
        total_chunks: 1,
        storage_provider: 'local',
      },
      {
        client_ref: 'google-ref',
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

  it('gets the opaque Google recovery context for the pending file', () => {
    service.getExternalUploadRecoveryContext(100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/external-upload-recovery-context`);
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.body).toBeNull();
    req.flush({
      storage_provider: 'google_drive',
      external_storage_id: 42,
      name_hash: 'opaque-hash',
    });
  });

  it('transfers ambiguous Google cancellation to the backend control plane', () => {
    service.cancelExternalUpload(100).subscribe();
    const req = httpMock.expectOne(`${environment.apiUrl}/files/100/external-upload-cancel`);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.body).toEqual({});
    req.flush({ status: 'cleanup_pending' });
  });

  it('maps storage targets without leaking backend field names', () => {
    let result: any;
    service.getStorageTargets().subscribe(value => result = value);
    const req = httpMock.expectOne(`${environment.apiUrl}/api/storage/targets`);
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ targets: [{
      key: 'google:7', provider: 'google_drive', label: 'Conta', external_storage_id: 7,
      account_email: 'user@example.com', used_bytes: 10, max_bytes: 100,
      available_bytes: 90, nanika_used_bytes: 5, status: 'ready',
    }] });

    expect(result[0]).toEqual(jasmine.objectContaining({
      externalStorageId: 7,
      accountEmail: 'user@example.com',
      availableBytes: 90,
    }));
    expect(result[0].external_storage_id).toBeUndefined();
  });

  it('preserves unavailable quota as null', () => {
    let result: any;
    service.getStorageTargets().subscribe(value => result = value);
    const req = httpMock.expectOne(`${environment.apiUrl}/api/storage/targets`);
    req.flush({ targets: [{
      key: 'google:8', provider: 'google_drive', label: 'Conta indisponível', external_storage_id: 8,
      account_email: 'unavailable@example.com', account_picture: null,
      used_bytes: null, max_bytes: null, available_bytes: null, nanika_used_bytes: 0,
      status: 'unavailable',
    }] });

    expect(result[0]).toEqual(jasmine.objectContaining({
      externalStorageId: 8,
      usedBytes: null,
      maxBytes: null,
      availableBytes: null,
      status: 'unavailable',
    }));
  });

  it('normalizes linked account pictures and rejects non-HTTPS values', () => {
    let result: any;
    service.getLinkedGoogleAccounts().subscribe(value => result = value);
    const req = httpMock.expectOne(`${environment.apiUrl}/api/storage/google/accounts`);
    req.flush({ accounts: [
      { id: 1, account_email: 'a@example.com', account_picture: ' https://lh3.googleusercontent.com/a ' },
      { id: 2, account_email: 'b@example.com', account_picture: 'http://insecure.example/b' },
      { id: 3, account_email: 'c@example.com', account_picture: null },
    ] });

    expect(result.accounts[0].account_picture).toBe('https://lh3.googleusercontent.com/a');
    expect(result.accounts[1].account_picture).toBeUndefined();
    expect(result.accounts[2].account_picture).toBeUndefined();
  });

  it('requests one paginated storage projection', () => {
    service.getStorageTree('google_drive', 7, 12, 25, 50).subscribe();
    const req = httpMock.expectOne(
      `${environment.apiUrl}/api/storage/tree?provider=google_drive&file_limit=25&file_offset=50&external_storage_id=7&folder_id=12`);
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ folders: [], files: [], has_more: false });
  });

  it('starts and controls a storage move using opaque identifiers', () => {
    const target = {
      key: 'google:7', provider: 'google_drive' as const, label: 'Conta', externalStorageId: 7,
      usedBytes: 0, maxBytes: 100, availableBytes: 100, nanikaUsedBytes: 0, status: 'ready' as const,
    };
    service.startStorageMove(9, target).subscribe();
    let req = httpMock.expectOne(`${environment.apiUrl}/files/9/storage-moves`);
    expect(req.request.body).toEqual({ target_provider: 'google_drive', target_external_storage_id: 7 });
    expect(JSON.stringify(req.request.body)).not.toContain('fileName');
    req.flush({});

    service.pauseStorageMove(3).subscribe();
    req = httpMock.expectOne(`${environment.apiUrl}/storage-moves/3/pause`);
    expect(req.request.method).toBe('POST');
    req.flush({});

    service.cancelStorageMove(3).subscribe();
    req = httpMock.expectOne(`${environment.apiUrl}/storage-moves/3`);
    expect(req.request.method).toBe('DELETE');
    req.flush({});
  });

  it('uses Range for local move sources and raw chunks for local targets', () => {
    service.downloadStorageMoveSourceRange(2, 4, 0, 1023).subscribe();
    let req = httpMock.expectOne(`${environment.apiUrl}/storage-moves/2/items/4/source`);
    expect(req.request.headers.get('Range')).toBe('bytes=0-1023');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob());

    const chunk = new Blob(['ciphertext']);
    service.uploadStorageMoveChunk(2, 4, 0, chunk).subscribe();
    req = httpMock.expectOne(`${environment.uploadApiUrl}/storage-moves/2/items/4/chunks/0`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toBe(chunk);
    req.flush({ transferred_bytes: chunk.size });
  });
});
