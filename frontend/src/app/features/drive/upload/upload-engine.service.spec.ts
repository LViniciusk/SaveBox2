import { HttpEventType } from '@angular/common/http';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveService } from '../services/drive.service';
import { UploadEngineService } from './upload-engine.service';
import { PreparedUpload } from './upload.models';

describe('UploadEngineService', () => {
  let engine: UploadEngineService;
  let drive: jasmine.SpyObj<DriveService>;
  let crypto: jasmine.SpyObj<CryptoService>;
  let kasumi: jasmine.SpyObj<KasumiCryptoService>;
  let http: HttpTestingController;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', ['getUploadedChunks', 'uploadChunk', 'finalizeExternalUpload']);
    crypto = jasmine.createSpyObj('CryptoService', ['encryptName', 'hashName']);
    kasumi = jasmine.createSpyObj('KasumiCryptoService', ['encryptFile']);
    crypto.encryptName.and.resolveTo('encrypted-value');
    crypto.hashName.and.resolveTo('name-hash');
    kasumi.encryptFile.and.resolveTo(new Blob(['encrypted-file']));
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [] }));
    drive.uploadChunk.and.returnValue(of(undefined));
    drive.finalizeExternalUpload.and.returnValue(of(undefined));

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), UploadEngineService,
        { provide: DriveService, useValue: drive },
        { provide: CryptoService, useValue: crypto },
        { provide: KasumiCryptoService, useValue: kasumi },
      ],
    });
    engine = TestBed.inject(UploadEngineService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('prepares an encrypted upload without exposing the original name to the payload contract', async () => {
    const file = new File(['plain'], 'secret.txt', { type: 'text/plain' });

    const prepared = await engine.prepareUpload(file);

    expect(crypto.encryptName).toHaveBeenCalledTimes(2);
    expect(crypto.encryptName.calls.argsFor(0)).toEqual(['secret.txt']);
    expect(crypto.hashName).toHaveBeenCalledWith('secret.txt');
    expect(prepared).toEqual(jasmine.objectContaining({
      file,
      encryptedName: 'encrypted-value',
      nameHash: 'name-hash',
      encryptedFdk: 'encrypted-value',
      encryptedSize: prepared.encryptedBlob.size,
      totalChunks: 1,
    }));
    expect(prepared.encryptedBlob).not.toBe(file);
  });

  it('uploads local chunks sequentially and reports progress', async () => {
    const progress: number[] = [];
    const prepared = makePrepared(new Blob(['chunk-data']));

    const result = await engine.execute(prepared, 7, 'local', {}, noPause(), {
      onProgress: update => progress.push(update.progress),
    });

    expect(result).toEqual({ paused: false });
    expect(drive.uploadChunk).toHaveBeenCalledTimes(1);
    expect(drive.uploadChunk).toHaveBeenCalledWith(7, 0, jasmine.any(Blob));
    expect(progress).toEqual([100]);
  });

  it('falls back to uploading all chunks when the resume endpoint fails', async () => {
    drive.getUploadedChunks.and.returnValue(throwError(() => new Error('offline')));
    const prepared = makePrepared(new Blob(['chunk-data']));

    await engine.execute(prepared, 8, 'local', {}, noPause(), { onProgress: () => undefined });

    expect(drive.uploadChunk).toHaveBeenCalledTimes(1);
  });

  it('stops before uploading when the transfer is paused', async () => {
    const prepared = makePrepared(new Blob(['chunk-data']));

    const result = await engine.execute(prepared, 9, 'local', {}, {
      shouldPause: () => true,
      shouldCancel: () => false,
    }, { onProgress: () => undefined });

    expect(result).toEqual({ paused: true });
    expect(drive.uploadChunk).not.toHaveBeenCalled();
  });

  it('uploads Google Drive multipart data and finalizes the local file', async () => {
    const progress: number[] = [];
    const prepared = makePrepared(new Blob(['encrypted-data']));
    const promise = engine.execute(prepared, 10, 'google_drive', {
      access_token: 'token',
      root_folder_id: 'root',
      name_hash: 'remote-name',
    }, noPause(), {
      onProgress: update => progress.push(update.progress),
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const request = http.expectOne('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart');

    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Authorization')).toBe('Bearer token');
    expect(request.request.headers.get('Content-Type')).toContain('multipart/related; boundary=');
    expect(request.request.body).toEqual(jasmine.any(Blob));
    request.event({ type: HttpEventType.UploadProgress, loaded: 5, total: 10 });
    request.flush({ id: 'external-id' });
    await promise;

    expect(progress).toEqual([50]);
    expect(drive.finalizeExternalUpload).toHaveBeenCalledWith(10, 'external-id');
  });

  function makePrepared(encryptedBlob: Blob): PreparedUpload {
    return {
      file: new File(['plain'], 'secret.txt'),
      encryptedBlob,
      encryptedName: 'encrypted-name',
      nameHash: 'hash',
      encryptedFdk: 'encrypted-fdk',
      fdk: new Uint8Array(32),
      totalChunks: Math.ceil(encryptedBlob.size / (4 * 1024 * 1024)),
      encryptedSize: encryptedBlob.size,
    };
  }

  function noPause() {
    return { shouldPause: () => false, shouldCancel: () => false };
  }
});
