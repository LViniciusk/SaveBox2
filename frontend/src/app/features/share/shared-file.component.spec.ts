import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SharedFileComponent } from './shared-file.component';
import { ShareService } from '../drive/services/share.service';
import { KasumiCryptoService } from '../../core/crypto/kasumi-crypto.service';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

describe('SharedFileComponent', () => {
  let fixture: any;
  let component: SharedFileComponent;
  let shareSpy: jasmine.SpyObj<ShareService>;
  let kasumiSpy: jasmine.SpyObj<KasumiCryptoService>;

  beforeEach(async () => {
    shareSpy = jasmine.createSpyObj('ShareService', ['getSharedFileMetadata', 'downloadSharedFile', 'downloadSharedFileInRanges']);
    kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['decryptName', 'decryptFile']);
    const mockRoute = {
      snapshot: { paramMap: { get: () => 'share-123' } }
    };

    await TestBed.configureTestingModule({
      imports: [SharedFileComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShareService, useValue: shareSpy },
        { provide: KasumiCryptoService, useValue: kasumiSpy },
        { provide: ActivatedRoute, useValue: mockRoute }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SharedFileComponent);
    component = fixture.componentInstance;
  });

  describe('decodeBase64UrlSafe', () => {
    it('should correctly restore padding and decode URL-Safe Base64 with minus character', () => {
      // Arrange
      // String "-g" corresponds to standard base64 "+g==" (btoa of char code 250)
      const urlSafeStr = '-g';

      // Act
      const result = component.decodeBase64UrlSafe(urlSafeStr);

      // Assert
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(1);
      expect(result[0]).toBe(250);
    });
    
    it('should correctly replace underscores with slashes and decode', () => {
      // Arrange
      // String "P_8" corresponds to standard base64 "P/8=" (btoa of char codes [63, 255])
      const urlSafeStr = 'P_8';
      
      // Act
      const result = component.decodeBase64UrlSafe(urlSafeStr);
      
      // Assert
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(2);
      expect(result[0]).toBe(63);
      expect(result[1]).toBe(255);
    });
  });

  it('loads and decrypts shared metadata with the supplied FDK', async () => {
    const metadata = {
      encrypted_name: 'encrypted-name',
      size_bytes: 2048,
      storage_provider: 'local'
    } as any;
    component.shareId = 'share-123';
    component.fdkUint8 = new Uint8Array([1, 2, 3]);
    shareSpy.getSharedFileMetadata.and.returnValue(of(metadata));
    kasumiSpy.decryptName.and.resolveTo('photo.png');

    await component.loadMetadata();

    expect(shareSpy.getSharedFileMetadata).toHaveBeenCalledWith('share-123');
    expect(kasumiSpy.decryptName).toHaveBeenCalledWith(metadata.encrypted_name, component.fdkUint8);
    expect(component.metadata()).toBe(metadata);
    expect(component.decryptedName()).toBe('photo.png');
    expect(component.sizeBytes()).toBe(2048);
    expect(component.loading()).toBeFalse();
  });

  it('reports expired or missing shares without exposing decrypted state', async () => {
    component.shareId = 'missing';
    component.fdkUint8 = new Uint8Array([1]);
    shareSpy.getSharedFileMetadata.and.returnValue(
      throwError(() => ({ error: { error: 'Link expirado' } }))
    );

    await component.loadMetadata();

    expect(component.error()).toBe('Link expirado');
    expect(component.loading()).toBeFalse();
    expect(component.decryptedName()).toBe('');
  });

  it('rejects metadata loading when the FDK is absent', async () => {
    component.shareId = 'share-123';
    component.fdkUint8 = null;
    shareSpy.getSharedFileMetadata.and.returnValue(of({ encrypted_name: 'name' } as any));

    await component.loadMetadata();

    expect(component.error()).toContain('descriptografar os metadados');
    expect(component.loading()).toBeFalse();
    expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
  });

  it('classifies shared files and formats their size for the UI', () => {
    component.decryptedName.set('photo.PNG');
    component.sizeBytes.set(1536);
    expect(component.isImage()).toBeTrue();
    expect(component.isMedia()).toBeTrue();
    expect(component.getFileIcon()).toBe('image');
    expect(component.getFormattedSize()).toBe('1.5 KB');

    component.decryptedName.set('movie.mp4');
    expect(component.isVideo()).toBeTrue();
    expect(component.getFileIcon()).toBe('movie');

    component.decryptedName.set('archive.zip');
    expect(component.isMedia()).toBeFalse();
    expect(component.getFileIcon()).toBe('zip_box');

    component.decryptedName.set('report.pdf');
    expect(component.getFileIcon()).toBe('picture_as_pdf');

    component.decryptedName.set('song.mp3');
    expect(component.getFileIcon()).toBe('audiotrack');

    component.decryptedName.set('notes.md');
    expect(component.getFileIcon()).toBe('description');

    component.decryptedName.set('unknown.bin');
    expect(component.getFileIcon()).toBe('insert_drive_file');
  });

  it('surfaces download failures and ignores downloads without an FDK', async () => {
    component.shareId = 'share-123';
    component.fdkUint8 = new Uint8Array([1]);
    shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.reject({ error: { error: 'Arquivo indisponível' } }));

    await component.downloadAndDecryptFile();

    expect(component.error()).toBe('Arquivo indisponível');
    expect(component.downloading()).toBeFalse();

    component.fdkUint8 = null;
    await component.downloadAndDecryptFile();
    expect(shareSpy.downloadSharedFileInRanges).toHaveBeenCalledTimes(1);
  });
});
