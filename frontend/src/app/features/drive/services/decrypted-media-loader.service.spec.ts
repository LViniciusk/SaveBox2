import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveFile } from '../state/drive.store';
import { DriveService } from './drive.service';
import { ShareService } from './share.service';
import { DecryptedMediaLoaderService } from './decrypted-media-loader.service';

describe('DecryptedMediaLoaderService', () => {
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
    crypto.decryptName.and.resolveTo(btoa('fdk'));
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
