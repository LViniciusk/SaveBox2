import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { PublicMediaPlayerComponent } from './public-media-player.component';
import { ShareService } from '../drive/services/share.service';
import { KasumiCryptoService } from '../../core/crypto/kasumi-crypto.service';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { VideoStreamService } from '../drive/services/video-stream.service';
import { Observable, of, throwError } from 'rxjs';
import { KASUMI_MAX_METADATA_SIZE } from '../../core/crypto/kasumi-format';

function fdkBytes(fill = 0x5a): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

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
    isVideo: boolean; isImage: boolean;
  }> = {}) {
    fixture.componentRef.setInput('shareId', overrides.shareId ?? 'share-1');
    fixture.componentRef.setInput('fdk', overrides.fdk ?? fdkBytes());
    fixture.componentRef.setInput('filename', overrides.filename ?? 'file.pdf');
    fixture.componentRef.setInput('sizeBytes', overrides.sizeBytes ?? 2048);
    fixture.componentRef.setInput('isVideo', overrides.isVideo ?? false);
    fixture.componentRef.setInput('isImage', overrides.isImage ?? false);
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

  it('loads canonical WebP thumbnails from JSON and legacy raw metadata', async () => {
    setInputs({ filename: 'movie.mp4', isVideo: true });
    const header = new Blob(['header']);
    shareSpy.downloadSharedFileRange.and.returnValue(of(header));
    let operationFdk!: Uint8Array;
    kasumiSpy.extractMetadata.and.callFake((_header: Blob, fdk: Uint8Array) => {
      operationFdk = fdk;
      return Promise.resolve({ metadata: JSON.stringify({ thumb: 'data:image/webp;base64,AA==' }), dataOffset: 40, expectedSize: 10 });
    });
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBe('data:image/webp;base64,AA==');
    expect(operationFdk).not.toBe((component as any).fdk());
    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
    expect(Array.from((component as any).fdk())).toEqual(new Array(32).fill(0x5a));
    expect(component.isLoading()).toBeFalse();

    kasumiSpy.extractMetadata.and.returnValue(Promise.resolve({ metadata: 'data:image/webp;base64,AA==', dataOffset: 40, expectedSize: 10 }));
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBe('data:image/webp;base64,AA==');

    kasumiSpy.extractMetadata.and.returnValue(Promise.resolve({ metadata: JSON.stringify({}), dataOffset: 40, expectedSize: 10 }));
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBe('data:image/webp;base64,AA==');
    (component as any).onThumbnailError();
    expect(component.thumbnailUrl()).toBeNull();
  });

  it('rejects network-capable and unsupported thumbnail representations', async () => {
    setInputs({ filename: 'movie.mp4', isVideo: true });
    shareSpy.downloadSharedFileRange.and.returnValue(of(new Blob(['header'])));

    const candidates = [
      'https://tracker.example/visitor-123',
      'http://tracker.example/x',
      'blob:https://app.example.test/id',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,AA==',
      'data:image/png;base64,AA==',
      'data:image/gif;base64,AA==',
      'data:image/bmp;base64,AA==',
      'data:image/avif;base64,AA==',
      'data:text/html;base64,AA==',
      'data:application/octet-stream;base64,AA==',
      'data:image/webp;charset=utf-8;base64,AA==',
      'data:image/WEBP;base64,AA==',
      'data:image/webp;base64,',
      'data:image/webp;base64,A',
      'data:image/webp;base64,AAA',
      'data:image/webp;base64,A===',
      'data:image/webp;base64,AA=A',
      'data:image/webp;base64,AA--',
      'data:image/webp;base64,áá==',
      'data:image/webp;base64,\nAA==',
    ];

    for (const candidate of candidates) {
      kasumiSpy.extractMetadata.and.resolveTo({
        metadata: JSON.stringify({ thumb: candidate }),
        dataOffset: 40,
        expectedSize: 10,
      });
      await component.loadHeaderThumbnail();
      expect(component.thumbnailUrl()).withContext(candidate).toBeNull();
      expect(component.error()).withContext(candidate).toBeNull();
      expect(component.isLoading()).withContext(candidate).toBeFalse();
    }
  });

  it('rejects non-string thumbnail values and unsupported JSON shapes', async () => {
    setInputs({ filename: 'movie.mp4', isVideo: true });
    shareSpy.downloadSharedFileRange.and.returnValue(of(new Blob(['header'])));

    const metadataValues = [
      JSON.stringify({ thumb: null }),
      JSON.stringify({ thumb: 123 }),
      JSON.stringify({ thumb: true }),
      JSON.stringify({ thumb: {} }),
      JSON.stringify({ thumb: [] }),
      '[]',
      '"data:image/webp;base64,AA=="',
      'null',
    ];

    for (const metadata of metadataValues) {
      kasumiSpy.extractMetadata.and.resolveTo({ metadata, dataOffset: 40, expectedSize: 10 });
      await component.loadHeaderThumbnail();
      expect(component.thumbnailUrl()).withContext(metadata).toBeNull();
    }
  });

  it('rejects an external thumbnail before it can render an image element', async () => {
    setInputs({ filename: 'movie.mp4', isVideo: true });
    spyOn(component, 'ngOnInit').and.stub();
    shareSpy.downloadSharedFileRange.and.returnValue(of(new Blob(['header'])));
    kasumiSpy.extractMetadata.and.resolveTo({
      metadata: JSON.stringify({ thumb: 'https://tracker.example/visitor-123' }),
      dataOffset: 40,
      expectedSize: 10,
    });

    await component.loadHeaderThumbnail();
    fixture.detectChanges();

    expect(component.thumbnailUrl()).toBeNull();
    expect(fixture.nativeElement.querySelector('img.video-thumbnail')).toBeNull();
    expect(component.error()).toBeNull();
  });

  it('accepts canonical WebP base64 and enforces the existing metadata-size bound', async () => {
    setInputs({ filename: 'movie.mp4', isVideo: true });
    shareSpy.downloadSharedFileRange.and.returnValue(of(new Blob(['header'])));

    const prefix = 'data:image/webp;base64,';
    const maxCanonicalLength = KASUMI_MAX_METADATA_SIZE - 1;
    expect((maxCanonicalLength - prefix.length) % 4).toBe(0);
    const atBound = prefix + 'A'.repeat(maxCanonicalLength - prefix.length);
    kasumiSpy.extractMetadata.and.resolveTo({ metadata: atBound, dataOffset: 40, expectedSize: 10 });
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBe(atBound);

    component.thumbnailUrl.set(null);
    const overBound = prefix + 'A'.repeat(KASUMI_MAX_METADATA_SIZE + 3 - prefix.length);
    kasumiSpy.extractMetadata.and.resolveTo({ metadata: overBound, dataOffset: 40, expectedSize: 10 });
    await component.loadHeaderThumbnail();
    expect(component.thumbnailUrl()).toBeNull();
  });

  it('starts thumbnail loading when initialized with a video', () => {
    Object.assign(component as any, {
      shareId: () => 'share-1',
      fdk: () => new Uint8Array([1, 2]),
      filename: () => 'movie.mp4',
      sizeBytes: () => 2048,
      isVideo: () => true,
      isImage: () => false
    });
    const loadHeaderThumbnail = spyOn(component, 'loadHeaderThumbnail').and.resolveTo();

    component.ngOnInit();

    expect(loadHeaderThumbnail).toHaveBeenCalled();
    expect(component.publicDriveFile().encryptedName).toBe('movie.mp4');
  });

  it('gives the video child its own FDK and wipes it independently from the parent input', () => {
    const parentFdk = fdkBytes(0x31);
    setInputs({ filename: 'movie.mp4', isVideo: true, fdk: parentFdk });
    spyOn(component, 'loadHeaderThumbnail').and.resolveTo();

    component.ngOnInit();

    const childFdk = component.publicDriveFile().shareFdk!;
    expect(childFdk).not.toBe(parentFdk);
    expect(childFdk).toBe((component as any).ownedFdk);
    expect(Array.from(childFdk)).toEqual(Array.from(parentFdk));

    component.ngOnDestroy();

    expect(Array.from(parentFdk)).toEqual(new Array(32).fill(0x31));
    expect(Array.from(childFdk)).toEqual(new Array(32).fill(0));
  });

  it('should retry short thumbnails and finish gracefully on errors', async () => {
    const retryFixture = TestBed.createComponent(PublicMediaPlayerComponent);
    const retryComponent = retryFixture.componentInstance;

    // Exercise the method directly so zoneless input change detection cannot
    // start a concurrent ngOnInit thumbnail request.
    Object.assign(retryComponent as any, {
      shareId: () => 'share-1',
      fdk: () => new Uint8Array([1, 2]),
      filename: () => 'movie.mp4',
      sizeBytes: () => 3 * 1024 * 1024,
      isVideo: () => true,
      isImage: () => false
    });

    const header = new Blob(['header']);
    shareSpy.downloadSharedFileRange.and.callFake((_shareId: string, _start: number, end: number) =>
      end === 512 * 1024 - 1 ? throwError(() => new Error('too small')) : of(header)
    );
    kasumiSpy.extractMetadata.and.returnValue(Promise.resolve({ metadata: null, dataOffset: 40, expectedSize: 10 }));
    await retryComponent.loadHeaderThumbnail();
    const ranges = shareSpy.downloadSharedFileRange.calls.allArgs();
    expect(ranges.some((args: unknown[]) => args[2] === 512 * 1024 - 1)).toBeTrue();
    expect(ranges.some((args: unknown[]) => args[2] === 2 * 1024 * 1024 - 1)).toBeTrue();
    expect(retryComponent.isLoading()).toBeFalse();

    shareSpy.downloadSharedFileRange.and.returnValue(throwError(() => new Error('offline')));
    await retryComponent.loadHeaderThumbnail();
    expect(retryComponent.error()).toBeNull();
    expect(retryComponent.isLoading()).toBeFalse();
    retryFixture.destroy();
  });

  it('uses a distinct wiped FDK copy for each thumbnail retry', async () => {
    const parentFdk = fdkBytes(0x26);
    setInputs({ filename: 'movie.mp4', isVideo: true, sizeBytes: 3 * 1024 * 1024, fdk: parentFdk });
    const operationFdks: Uint8Array[] = [];
    let attempts = 0;
    shareSpy.downloadSharedFileRange.and.returnValue(of(new Blob(['header'])));
    kasumiSpy.extractMetadata.and.callFake((_header: Blob, fdk: Uint8Array) => {
      operationFdks.push(fdk);
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error('too small'))
        : Promise.resolve({ metadata: null, dataOffset: 40, expectedSize: 10 });
    });

    await component.loadHeaderThumbnail();

    expect(operationFdks.length).toBe(2);
    expect(operationFdks[0]).not.toBe(operationFdks[1]);
    expect(Array.from(operationFdks[0])).toEqual(new Array(32).fill(0));
    expect(Array.from(operationFdks[1])).toEqual(new Array(32).fill(0));
    expect(Array.from(parentFdk)).toEqual(new Array(32).fill(0x26));
  });

  it('should decrypt an image and handle image failures', async () => {
    const parentFdk = fdkBytes(0x42);
    setInputs({ filename: 'photo.jpg', isImage: true, fdk: parentFdk });
    const encrypted = new Blob(['encrypted']);
    const decrypted = new Blob(['raw']);
    shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.resolve(encrypted));
    let operationFdk!: Uint8Array;
    kasumiSpy.decryptFile.and.callFake((_encrypted: Blob, fdk: Uint8Array) => {
      operationFdk = fdk;
      return Promise.resolve(decrypted);
    });
    spyOn(URL, 'createObjectURL').and.returnValue('blob:image');
    spyOn(URL, 'revokeObjectURL');

    await (component as any).loadImage();
    expect(component.mediaUrl()).toBe('blob:image');
    expect(operationFdk).not.toBe(parentFdk);
    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
    expect(Array.from(parentFdk)).toEqual(new Array(32).fill(0x42));
    expect(component.isLoading()).toBeFalse();

    kasumiSpy.decryptFile.and.callFake((_encrypted: Blob, fdk: Uint8Array) => {
      operationFdk = fdk;
      return Promise.reject({ error: { error: 'decrypt failed' } });
    });
    await (component as any).loadImage();
    expect(component.error()).toBe('decrypt failed');
    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
    expect(Array.from(parentFdk)).toEqual(new Array(32).fill(0x42));
    expect(component.isLoading()).toBeFalse();
  });

  describe('downloadFile', () => {
    it('should download encrypted blob via HTTP, decrypt and trigger download via object URL', async () => {
      fixture.componentRef.setInput('shareId', 'share-123');
      fixture.componentRef.setInput('fdk', fdkBytes(0x27));
      fixture.componentRef.setInput('filename', 'test.mkv');
      fixture.componentRef.setInput('sizeBytes', 100);
      fixture.componentRef.setInput('isVideo', true);
      fixture.componentRef.setInput('isImage', false);

      const fakeEncryptedBlob = new Blob(['encrypted data']);
      const fakeDecryptedBlob = new Blob(['decrypted data']);
      shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.resolve(fakeEncryptedBlob));
      let operationFdk!: Uint8Array;
      kasumiSpy.decryptFile.and.callFake((_encrypted: Blob, fdk: Uint8Array) => {
        operationFdk = fdk;
        return Promise.resolve(fakeDecryptedBlob);
      });
      
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

      expect(kasumiSpy.decryptFile).toHaveBeenCalledWith(fakeEncryptedBlob, jasmine.any(Uint8Array), 100);
      expect(operationFdk).not.toBe((component as any).fdk());
      expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
      expect(Array.from((component as any).fdk())).toEqual(new Array(32).fill(0x27));
      expect(shareSpy.downloadSharedFileInRanges).toHaveBeenCalledWith(
        'share-123', 100, jasmine.any(Function), jasmine.any(AbortSignal),
      );
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
      expect((component as any).ownedFdk).toBeNull();
    });

    it('should update progress while downloading ranges and handle errors', async () => {
      setInputs({ filename: 'file.pdf', sizeBytes: 1000 });
      let progressDuringDownload: number | null = null;
      shareSpy.downloadSharedFileInRanges.and.callFake(async (_id: string, _size: number, onProgress?: (loaded: number, total: number) => void) => {
        onProgress?.(500, 1000);
        progressDuringDownload = component.downloadProgress();
        return new Blob(['encrypted']);
      });
      let operationFdk!: Uint8Array;
      kasumiSpy.decryptFile.and.callFake((_encrypted: Blob, fdk: Uint8Array) => {
        operationFdk = fdk;
        return Promise.reject(new Error('bad decrypt'));
      });

      await (component as any).downloadFile();
      expect(progressDuringDownload as any).toBe(50);
      expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
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

  it('aborts pending thumbnail work when the public player is destroyed', async () => {
    let unsubscribed = false;
    shareSpy.downloadSharedFileRange.and.returnValue(new Observable(() => () => {
      unsubscribed = true;
    }));
    setInputs({ filename: 'movie.mp4', isVideo: true });
    const pending = component.loadHeaderThumbnail();

    component.ngOnDestroy();
    await Promise.resolve();

    expect(unsubscribed).toBeTrue();
    expect(component.thumbnailUrl()).toBeNull();
    void pending;
  });

  it('passes lifecycle ownership to public image downloads', async () => {
    shareSpy.downloadSharedFileInRanges.and.returnValue(new Promise(() => {}));
    setInputs({ filename: 'photo.jpg', isImage: true });
    const pending = (component as any).loadImage();
    await Promise.resolve();

    expect(shareSpy.downloadSharedFileInRanges).toHaveBeenCalledWith(
      'share-1', 2048, undefined, jasmine.any(AbortSignal),
    );
    component.ngOnDestroy();
    void pending;
  });

  it('does not publish a public image after close during decryption', async () => {
    const parentFdk = fdkBytes(0x63);
    const encrypted = new Blob(['encrypted']);
    let resolveDecrypt!: (value: Blob) => void;
    let operationFdk!: Uint8Array;
    shareSpy.downloadSharedFileInRanges.and.returnValue(Promise.resolve(encrypted));
    kasumiSpy.decryptFile.and.callFake((_encrypted: Blob, fdk: Uint8Array) => {
      operationFdk = fdk;
      return new Promise(resolve => { resolveDecrypt = resolve; });
    });
    const createUrl = spyOn(URL, 'createObjectURL').and.returnValue('blob:stale');
    setInputs({ filename: 'photo.jpg', isImage: true, fdk: parentFdk });

    const pending = (component as any).loadImage();
    await Promise.resolve();
    await Promise.resolve();
    expect(operationFdk).not.toBe(parentFdk);
    component.ngOnDestroy();
    expect(Array.from(parentFdk)).toEqual(new Array(32).fill(0x63));
    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0x63));
    resolveDecrypt(new Blob(['plain']));
    await pending;

    expect(createUrl).not.toHaveBeenCalled();
    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
    expect(Array.from(parentFdk)).toEqual(new Array(32).fill(0x63));
    expect(component.mediaUrl()).toBeNull();
  });

  it('aborts public downloads and suppresses stale progress and anchor clicks', async () => {
    let progress!: (loaded: number, total: number) => void;
    let resolveDownload!: (value: Blob) => void;
    shareSpy.downloadSharedFileInRanges.and.callFake((_id: string, _size: number, callback: (loaded: number, total: number) => void, signal: AbortSignal) => {
      progress = callback;
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Promise(resolve => { resolveDownload = resolve; });
    });
    const click = jasmine.createSpy('click');
    const anchor = { click, download: '', href: '' } as any;
    spyOn(document, 'createElement').and.callFake((tag: string) => tag === 'a' ? anchor : document.createElement(tag));
    setInputs({ filename: 'archive.bin' });
    const pending = (component as any).downloadFile();
    await Promise.resolve();
    component.ngOnDestroy();
    progress(512, 1024);
    resolveDownload(new Blob(['encrypted']));
    await pending;

    expect(component.downloadProgress()).toBeNull();
    expect(click).not.toHaveBeenCalled();
  });

  it('makes close terminal for owned public work', () => {
    spyOn(component.close, 'emit');
    const signal = (component as any).lifecycleController.signal as AbortSignal;

    (component as any).onClose();

    expect(signal.aborted).toBeTrue();
    expect(component.close.emit).toHaveBeenCalled();
  });
});
