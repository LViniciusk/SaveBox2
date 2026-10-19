import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveFile } from '../state/drive.store';
import { DriveService } from './drive.service';
import { ShareService } from './share.service';
import { DecryptedMediaLoaderService } from './decrypted-media-loader.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => resolve = complete);
  return { promise, resolve };
}

describe('DecryptedMediaLoaderService', () => {
  const fdkBytes = (value = 0x5a) => new Uint8Array(32).fill(value);
  const base64Bytes = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  let service: DecryptedMediaLoaderService;
  let drive: jasmine.SpyObj<DriveService>;
  let share: jasmine.SpyObj<ShareService>;
  let crypto: jasmine.SpyObj<CryptoService>;
  let kasumi: jasmine.SpyObj<KasumiCryptoService>;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', ['downloadFileInRanges', 'downloadExternalMetadata', 'downloadExternalFileRange']);
    share = jasmine.createSpyObj('ShareService', ['downloadSharedFileInRanges']);
    crypto = jasmine.createSpyObj('CryptoService', ['decryptName']);
    kasumi = jasmine.createSpyObj('KasumiCryptoService', ['decryptFile']);
    drive.downloadFileInRanges.and.resolveTo(new Blob(['local']));
    drive.downloadExternalMetadata.and.returnValue(of({ storage_provider: 'google_drive', external_file_id: 'remote', access_token: 'token' }));
    drive.downloadExternalFileRange.and.returnValue(of(new Blob(['google'])));
    share.downloadSharedFileInRanges.and.resolveTo(new Blob(['shared']));
    crypto.decryptName.and.resolveTo(base64Bytes(fdkBytes()));
    kasumi.decryptFile.and.resolveTo(new Blob(['plain']));
    spyOn(URL, 'createObjectURL').and.returnValue('blob:preview');
    spyOn(URL, 'revokeObjectURL');

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), DecryptedMediaLoaderService,
        { provide: DriveService, useValue: drive }, { provide: ShareService, useValue: share },
        { provide: CryptoService, useValue: crypto }, { provide: KasumiCryptoService, useValue: kasumi },
      ],
    });
    service = TestBed.inject(DecryptedMediaLoaderService);
  });

  it('loads local encrypted media and revokes its blob URL idempotently', async () => {
    const resource = await service.load(file({ decryptedName: 'song.mp3' }));

    expect(resource.mimeType).toBe('audio/mpeg');
    expect(drive.downloadFileInRanges).toHaveBeenCalledWith(1, 10, undefined);
    resource.cleanup();
    resource.cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('wipes the loader-owned local FDK after successful decryption', async () => {
    let capturedFdk!: Uint8Array;
    kasumi.decryptFile.and.callFake(async (_encryptedBlob, fdk: Uint8Array) => {
      capturedFdk = fdk;
      expect(fdk).toEqual(fdkBytes());
      return new Blob(['plain']);
    });

    await service.load(file({ decryptedName: 'song.mp3' }));

    expect(capturedFdk).toEqual(new Uint8Array(32));
  });

  it('wipes the loader-owned local FDK when decryption fails', async () => {
    let capturedFdk!: Uint8Array;
    kasumi.decryptFile.and.callFake(async (_encryptedBlob, fdk: Uint8Array) => {
      capturedFdk = fdk;
      throw new Error('A16M_MEDIA_DECRYPT_FAILURE');
    });

    await expectAsync(service.load(file({ decryptedName: 'song.mp3' })))
      .toBeRejectedWithError('A16M_MEDIA_DECRYPT_FAILURE');

    expect(capturedFdk).toEqual(new Uint8Array(32));
  });

  it('copies and wipes a public-share FDK without mutating the caller', async () => {
    const callerFdk = fdkBytes();
    const originalCallerBytes = Array.from(callerFdk);
    let capturedFdk!: Uint8Array;
    kasumi.decryptFile.and.callFake(async (_encryptedBlob, fdk: Uint8Array) => {
      capturedFdk = fdk;
      expect(fdk).not.toBe(callerFdk);
      expect(fdk).toEqual(fdkBytes());
      return new Blob(['plain']);
    });

    await service.load(file({ shareUuid: 'share-1', shareFdk: callerFdk }));

    expect(capturedFdk).toEqual(new Uint8Array(32));
    expect(Array.from(callerFdk)).toEqual(originalCallerBytes);
  });

  it('wipes only the public-share working copy when decryption fails', async () => {
    const callerFdk = fdkBytes();
    const originalCallerBytes = Array.from(callerFdk);
    let capturedFdk!: Uint8Array;
    kasumi.decryptFile.and.callFake(async (_encryptedBlob, fdk: Uint8Array) => {
      capturedFdk = fdk;
      throw new Error('A16M_PUBLIC_MEDIA_FAILURE');
    });

    await expectAsync(service.load(file({ shareUuid: 'share-1', shareFdk: callerFdk })))
      .toBeRejectedWithError('A16M_PUBLIC_MEDIA_FAILURE');

    expect(capturedFdk).toEqual(new Uint8Array(32));
    expect(Array.from(callerFdk)).toEqual(originalCallerBytes);
  });

  it('wipes the FDK when abort is observed after decryption', async () => {
    const controller = new AbortController();
    let capturedFdk!: Uint8Array;
    kasumi.decryptFile.and.callFake(async (_encryptedBlob, fdk: Uint8Array) => {
      capturedFdk = fdk;
      controller.abort();
      return new Blob(['plain']);
    });

    let failure: any;
    try {
      await service.load(file({ decryptedName: 'song.mp3' }), controller.signal);
    } catch (error) {
      failure = error;
    }

    expect(failure?.name).toBe('AbortError');
    expect(capturedFdk).toEqual(new Uint8Array(32));
  });

  it('preserves the missing-FDK error', async () => {
    await expectAsync(service.load(file({ encryptedFdk: undefined } as any)))
      .toBeRejectedWithError('Chave de criptografia nao encontrada (FDK)');
  });

  it('rejects pre-aborted local, Google and share loads before any work', async () => {
    const controller = new AbortController();
    controller.abort();

    const sources: Partial<DriveFile>[] = [{}, { storageProvider: 'google_drive' }, { shareUuid: 'share', shareFdk: fdkBytes() }];
    for (const values of sources) {
      await expectAsync(service.load(file(values), controller.signal))
        .toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));
    }

    expect(drive.downloadFileInRanges).not.toHaveBeenCalled();
    expect(drive.downloadExternalMetadata).not.toHaveBeenCalled();
    expect(drive.downloadExternalFileRange).not.toHaveBeenCalled();
    expect(share.downloadSharedFileInRanges).not.toHaveBeenCalled();
    expect(crypto.decryptName).not.toHaveBeenCalled();
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('unsubscribes the real local range download on abort before decryption', async () => {
    const range = new Subject<Blob>();
    const controller = new AbortController();
    drive.downloadFileInRanges.and.callFake((id, size, signal) =>
      DriveService.prototype.downloadFileInRanges.call(
        { downloadFileRange: () => range } as unknown as DriveService, id, size, signal,
      ));

    const loading = service.load(file({}), controller.signal);
    expect(range.observed).toBeTrue();
    controller.abort();
    expect(range.observed).toBeFalse();
    await expectAsync(loading).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));

    expect(crypto.decryptName).not.toHaveBeenCalled();
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('unsubscribes pending Google metadata on abort without starting a range', async () => {
    const metadata = new Subject<any>();
    const controller = new AbortController();
    drive.downloadExternalMetadata.and.returnValue(metadata);

    const loading = service.load(file({ storageProvider: 'google_drive' }), controller.signal);
    expect(metadata.observed).toBeTrue();
    controller.abort();
    expect(metadata.observed).toBeFalse();
    await expectAsync(loading).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));

    expect(drive.downloadExternalFileRange).not.toHaveBeenCalled();
    expect(crypto.decryptName).not.toHaveBeenCalled();
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('unsubscribes a pending Google range on abort before decryption', async () => {
    const range = new Subject<Blob>();
    const controller = new AbortController();
    drive.downloadExternalFileRange.and.returnValue(range);

    const loading = service.load(file({ storageProvider: 'google_drive' }), controller.signal);
    await Promise.resolve();
    expect(range.observed).toBeTrue();
    controller.abort();
    expect(range.observed).toBeFalse();
    await expectAsync(loading).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));

    expect(crypto.decryptName).not.toHaveBeenCalled();
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('wipes the FDK resolved after abort while decryptName was pending', async () => {
    const name = deferred<string>();
    const started = deferred<void>();
    const controller = new AbortController();
    const ownedFdk = spyOn<any>(service, 'resolveOwnedFdk').and.callThrough();
    crypto.decryptName.and.callFake(() => {
      started.resolve();
      return name.promise;
    });

    const loading = service.load(file({}), controller.signal);
    await started.promise;
    controller.abort();
    name.resolve(base64Bytes(fdkBytes()));
    await expectAsync(loading).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));

    expect(await ownedFdk.calls.mostRecent().returnValue).toEqual(new Uint8Array(32));
    expect(kasumi.decryptFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('withholds publication and wipes only the share working copy after an aborted decrypt finishes', async () => {
    const decrypt = deferred<Blob>();
    const started = deferred<void>();
    const callerFdk = fdkBytes();
    const original = callerFdk.slice();
    const controller = new AbortController();
    let workingFdk!: Uint8Array;
    kasumi.decryptFile.and.callFake((_blob, fdk) => {
      workingFdk = fdk;
      started.resolve();
      return decrypt.promise;
    });

    const loading = service.load(file({ shareUuid: 'share', shareFdk: callerFdk }), controller.signal);
    await started.promise;
    expect(workingFdk).not.toBe(callerFdk);
    controller.abort();
    decrypt.resolve(new Blob(['plain']));
    await expectAsync(loading).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));

    expect(workingFdk).toEqual(new Uint8Array(32));
    expect(callerFdk).toEqual(original);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('never lets an aborted old decrypt create or revoke the new resource', async () => {
    const decrypt = deferred<Blob>();
    const started = deferred<void>();
    const controller = new AbortController();
    let oldFdk!: Uint8Array;
    kasumi.decryptFile.and.callFake((_blob, fdk) => {
      oldFdk = fdk;
      started.resolve();
      return decrypt.promise;
    });
    const oldLoad = service.load(file({}), controller.signal);
    await started.promise;
    controller.abort();

    kasumi.decryptFile.and.resolveTo(new Blob(['new']));
    const resource = await service.load(file({ id: 2 }));
    decrypt.resolve(new Blob(['old']));
    await expectAsync(oldLoad).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));

    expect(oldFdk).toEqual(new Uint8Array(32));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(resource.url).toBe('blob:preview');
    resource.cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnceWith(resource.url);
  });

  it('transfers cleanup ownership to the caller after returning the resource', async () => {
    const controller = new AbortController();
    const resource = await service.load(file({}), controller.signal);

    controller.abort();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    resource.cleanup();
    resource.cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnceWith(resource.url);
  });

  it('uses the Google Drive range path without exposing the remote token', async () => {
    await service.load(file({ storageProvider: 'google_drive', decryptedName: 'image.png', type: 'image' }));

    expect(drive.downloadExternalMetadata).toHaveBeenCalledWith(1);
    expect(drive.downloadExternalFileRange).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/remote?alt=media', 'token', 0, 9
    );
  });

  function file(values: Partial<DriveFile>): DriveFile {
    return {
      id: 1, isFolder: false, encryptedName: 'cipher', decryptedName: 'file.bin', type: 'unknown',
      sizeBytes: 10, sizeFormatted: '10 B', modifiedAt: '', owner: '', encryptedFdk: 'fdk',
      storageProvider: 'local', externalStorageId: null, ...values,
    };
  }
});
