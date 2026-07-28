import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { PublicMediaPlayerComponent } from './public-media-player.component';
import { ShareService } from '../drive/services/share.service';
import { KasumiCryptoService } from '../../core/crypto/kasumi-crypto.service';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { VideoStreamService } from '../drive/services/video-stream.service';
import { of, throwError } from 'rxjs';

describe('PublicMediaPlayerComponent', () => {
  let fixture: any;
  let component: PublicMediaPlayerComponent;
  let httpMock: HttpTestingController;
  let kasumiSpy: any;
  let shareSpy: any;

  beforeEach(async () => {
    shareSpy = jasmine.createSpyObj('ShareService', ['downloadSharedFileRange', 'downloadSharedFile', 'downloadSharedFileInRanges']);
    kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['decryptFile', 'extractMetadata']);
    const videoStreamSpy = jasmine.createSpyObj('VideoStreamService', ['destroyStream']);

    await TestBed.configureTestingModule({
      imports: [PublicMediaPlayerComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ShareService, useValue: shareSpy },
        { provide: KasumiCryptoService, useValue: kasumiSpy },
        { provide: VideoStreamService, useValue: videoStreamSpy }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(PublicMediaPlayerComponent);
    component = fixture.componentInstance;
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('getMimeType', () => {
    it('should return correct mime type for .mkv', () => {
      // Act & Assert
      expect(component.getMimeType('movie.mkv')).toBe('video/x-matroska');
    });

    it('should return correct mime type for .webp', () => {
      // Act & Assert
      expect(component.getMimeType('image.webp')).toBe('image/webp');
    });

    it('should return default for unknown extensions', () => {
      // Act & Assert
      expect(component.getMimeType('file.xyz')).toBe('application/octet-stream');
    });

    it('should map common media extensions', () => {
      expect(component.getMimeType('x.mp4')).toBe('video/mp4');
      expect(component.getMimeType('x.webm')).toBe('video/webm');
      expect(component.getMimeType('x.ogv')).toBe('video/ogg');
      expect(component.getMimeType('x.ogg')).toBe('video/ogg');
      expect(component.getMimeType('x.mov')).toBe('video/quicktime');
      expect(component.getMimeType('x.jpg')).toBe('image/jpeg');
      expect(component.getMimeType('x.jpeg')).toBe('image/jpeg');
      expect(component.getMimeType('x.png')).toBe('image/png');
      expect(component.getMimeType('x.gif')).toBe('image/gif');
      expect(component.getMimeType('x.svg')).toBe('image/svg+xml');
      expect(component.getMimeType('x.bmp')).toBe('image/bmp');
    });
  });

  function setInputs(overrides: Partial<{
    shareId: string; fdk: Uint8Array; filename: string; sizeBytes: number;
    isVideo: boolean; isImage: boolean; storageProvider: string;
  }> = {}) {
    fixture.componentRef.setInput('shareId', overrides.shareId ?? 'share-1');
    fixture.componentRef.setInput('fdk', overrides.fdk ?? new Uint8Array([1, 2]));
    fixture.componentRef.setInput('filename', overrides.filename ?? 'file.pdf');
    fixture.componentRef.setInput('sizeBytes', overrides.sizeBytes ?? 2048);
    fixture.componentRef.setInput('isVideo', overrides.isVideo ?? false);
    fixture.componentRef.setInput('isImage', overrides.isImage ?? false);
    if (overrides.storageProvider) fixture.componentRef.setInput('storageProvider', overrides.storageProvider);
  }

  it('should classify files, initialize non-media and clean up', () => {
    setInputs({ filename: 'report.xlsx' });
    expect(component.fileType()).toBe('spreadsheet');
    component.ngOnInit();
    expect(component.isLoading()).toBeFalse();

    setInputs({ filename: 'archive.zip' });
    expect(component.fileType()).toBe('zip');
    setInputs({ filename: 'song.mp3' });
    expect(component.fileType()).toBe('audio');
    setInputs({ filename: 'notes.md' });
    expect(component.fileType()).toBe('txt');
    setInputs({ filename: 'document.docx' });
    expect(component.fileType()).toBe('doc');
    setInputs({ filename: 'unknown.bin' });
    expect(component.fileType()).toBe('default');

    const close = jasmine.createSpy('close');
    component.close.subscribe(close);
    (component as any).onKeyDown({ key: 'Enter' });
    expect(close).not.toHaveBeenCalled();
    (component as any).onKeyDown({ key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });

  it('should load video thumbnails from JSON, data URLs and missing thumbnails', async () => {
    setInputs({ filename: 'movie.mp4', isVideo: true });
    const header = new Blob(['header']);
    shareSpy.downloadSharedFileRange.and.returnValue(of(header));
    kasumiSpy.extractMetadata.and.returnValue(Promise.resolve({ metadata: JSON.stringify({ thumb: 'thumb-url' }), dataOffset: 40, expectedSize: 10 }));
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBe('thumb-url');
    expect(component.isLoading()).toBeFalse();

    kasumiSpy.extractMetadata.and.returnValue(Promise.resolve({ metadata: 'data:image/png;base64,AA==', dataOffset: 40, expectedSize: 10 }));
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBe('data:image/png;base64,AA==');

    kasumiSpy.extractMetadata.and.returnValue(Promise.resolve({ metadata: JSON.stringify({}), dataOffset: 40, expectedSize: 10 }));
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBe('data:image/png;base64,AA==');
    (component as any).onThumbnailError();
    expect(component.thumbnailUrl()).toBeNull();
  });

  it('should retry short thumbnails and finish gracefully on errors', async () => {
    setInputs({ filename: 'movie.mp4', isVideo: true });
    const header = new Blob(['header']);
    shareSpy.downloadSharedFileRange.and.returnValues(
      throwError(() => new Error('too small')),
      of(header)
    );
    kasumiSpy.extractMetadata.and.returnValue(Promise.resolve({ metadata: null, dataOffset: 40, expectedSize: 10 }));
    await component.loadHeaderThumbnail();
    expect(shareSpy.downloadSharedFileRange).toHaveBeenCalledWith('share-1', 0, 512 * 1024 - 1);
    expect(shareSpy.downloadSharedFileRange).toHaveBeenCalledWith('share-1', 0, 2 * 1024 * 1024 - 1);
    expect(component.isLoading()).toBeFalse();

    shareSpy.downloadSharedFileRange.and.returnValue(throwError(() => new Error('offline')));
    await component.loadHeaderThumbnail();
    expect(component.error()).toBeNull();
    expect(component.isLoading()).toBeFalse();
  });

  it('should decrypt an image and handle image failures', async () => {
    setInputs({ filename: 'photo.jpg', isImage: true });
    const encrypted = new Blob(['encrypted']);
    const decrypted = new Blob(['raw']);
    shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.resolve(encrypted));
    kasumiSpy.decryptFile.and.returnValue(Promise.resolve(decrypted));
    spyOn(URL, 'createObjectURL').and.returnValue('blob:image');
    spyOn(URL, 'revokeObjectURL');

    await (component as any).loadImage();
    expect(component.mediaUrl()).toBe('blob:image');
    expect(component.isLoading()).toBeFalse();

    kasumiSpy.decryptFile.and.returnValue(Promise.reject({ error: { error: 'decrypt failed' } }));
    await (component as any).loadImage();
    expect(component.error()).toBe('decrypt failed');
    expect(component.isLoading()).toBeFalse();
  });

  describe('downloadFile', () => {
    it('should download encrypted blob via HTTP, decrypt and trigger download via object URL', async () => {
      fixture.componentRef.setInput('shareId', 'share-123');
      fixture.componentRef.setInput('fdk', new Uint8Array([1, 2, 3]));
      fixture.componentRef.setInput('filename', 'test.mkv');
      fixture.componentRef.setInput('sizeBytes', 100);
      fixture.componentRef.setInput('isVideo', true);
      fixture.componentRef.setInput('isImage', false);

      const fakeEncryptedBlob = new Blob(['encrypted data']);
      const fakeDecryptedBlob = new Blob(['decrypted data']);
      shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.resolve(fakeEncryptedBlob));
      kasumiSpy.decryptFile.and.returnValue(Promise.resolve(fakeDecryptedBlob));
      
      spyOn(URL, 'createObjectURL').and.returnValue('blob:test-url');
      spyOn(URL, 'revokeObjectURL');
      
      const anchorSpy = jasmine.createSpyObj('a', ['click']);
      const originalCreateElement = document.createElement.bind(document);
      spyOn(document, 'createElement').and.callFake((tagName: string) => {
        if (tagName === 'a') return anchorSpy as any;
        return originalCreateElement(tagName);
      });
      spyOn(document.body, 'appendChild');
      spyOn(document.body, 'removeChild');

      await (component as any).downloadFile();

      expect(kasumiSpy.decryptFile).toHaveBeenCalledWith(fakeEncryptedBlob, jasmine.any(Uint8Array));
      expect(shareSpy.downloadSharedFileInRanges).toHaveBeenCalledWith('share-123', 100, jasmine.any(Function));
      expect(URL.createObjectURL).toHaveBeenCalledWith(fakeDecryptedBlob);
      expect(document.createElement).toHaveBeenCalledWith('a');
      expect(anchorSpy.download).toBe('test.mkv');
      expect(anchorSpy.href).toBe('blob:test-url');
      expect(anchorSpy.click).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
    });

    it('should download an already decrypted blob without making an HTTP request', () => {
      setInputs({ filename: 'photo.png', isImage: true });
      (component as any).decryptedBlob = new Blob(['raw']);
      spyOn(URL, 'createObjectURL').and.returnValue('blob:memory');
      spyOn(URL, 'revokeObjectURL');
      const anchorSpy = jasmine.createSpyObj('a', ['click']);
      spyOn(document, 'createElement').and.returnValue(anchorSpy as any);
      spyOn(document.body, 'appendChild');
      spyOn(document.body, 'removeChild');

      (component as any).downloadFile();

      expect(anchorSpy.download).toBe('photo.png');
      expect(anchorSpy.click).toHaveBeenCalled();
      expect(shareSpy.downloadSharedFileInRanges).not.toHaveBeenCalled();
    });

    it('should update progress while downloading ranges and handle errors', async () => {
      setInputs({ filename: 'file.pdf', sizeBytes: 1000 });
      let progressDuringDownload: number | null = null;
      shareSpy.downloadSharedFileInRanges.and.callFake(async (_id: string, _size: number, onProgress?: (loaded: number, total: number) => void) => {
        onProgress?.(500, 1000);
        progressDuringDownload = component.downloadProgress();
        return new Blob(['encrypted']);
      });
      kasumiSpy.decryptFile.and.returnValue(Promise.reject(new Error('bad decrypt')));

      await (component as any).downloadFile();
      expect(progressDuringDownload as any).toBe(50);
      expect(component.isDownloading()).toBeFalse();
      expect(component.downloadProgress()).toBeNull();

      shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.reject(new Error('offline')));
      await (component as any).downloadFile();
      expect(component.isDownloading()).toBeFalse();
      expect(component.downloadProgress()).toBeNull();
    });

    it('should finish a response download and handle decryption errors', async () => {
      setInputs({ filename: 'file.pdf' });
      kasumiSpy.decryptFile.and.returnValue(Promise.resolve(new Blob(['raw'])));
      spyOn(URL, 'createObjectURL').and.returnValue('blob:download');
      spyOn(URL, 'revokeObjectURL');
      const anchorSpy = jasmine.createSpyObj('a', ['click']);
      const originalCreateElement = document.createElement.bind(document);
      spyOn(document, 'createElement').and.callFake((tagName: string) =>
        tagName === 'a' ? anchorSpy as any : originalCreateElement(tagName)
      );
      spyOn(document.body, 'appendChild');
      spyOn(document.body, 'removeChild');

      shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.resolve(new Blob(['encrypted'])));
      await (component as any).downloadFile();
      expect(component.isDownloading()).toBeFalse();

      kasumiSpy.decryptFile.and.returnValue(Promise.reject(new Error('bad decrypt')));
      await (component as any).downloadFile();
      expect(component.isDownloading()).toBeFalse();
    });
  });

  it('should apply zoom and drag only for zoomed images', () => {
    setInputs({ isVideo: false, isImage: true });
    (component as any).onWheel({ deltaY: -1 });
    expect(component.currentZoom()).toBe(1.25);
    (component as any).onWheel({ deltaY: 1 });
    expect(component.currentZoom()).toBe(1);
    (component as any).onWheel({ deltaY: 0 });
    expect(component.currentZoom()).toBe(1);

    (component as any).onMouseDown({ clientX: 10, clientY: 20 });
    expect(component.isDragging).toBeFalse();
    component.currentZoom.set(2);
    (component as any).onMouseDown({ clientX: 10, clientY: 20 });
    expect(component.isDragging).toBeTrue();
    (component as any).onMouseMove({ clientX: 30, clientY: 50 });
    expect(component.translateX()).toBe(20);
    expect(component.translateY()).toBe(30);
    (component as any).onMouseUp();
    expect(component.isDragging).toBeFalse();
    component.currentZoom.set(3);
    (component as any).zoomIn();
    expect(component.currentZoom()).toBe(3);
    (component as any).zoomOut();
    (component as any).resetZoom();
    expect(component.currentZoom()).toBe(1);

    setInputs({ isVideo: true });
    (component as any).onWheel({ deltaY: -1 });
    expect(component.currentZoom()).toBe(1);
  });
});
