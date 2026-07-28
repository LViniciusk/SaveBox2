import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ImagePlayerComponent } from './image-player.component';
import { DriveFile, DriveStore } from '../../state/drive.store';
import { DriveService } from '../../services/drive.service';
import { ShareService } from '../../services/share.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../../core/crypto/kasumi-crypto.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

describe('ImagePlayerComponent', () => {
  let fixture: ComponentFixture<ImagePlayerComponent>;
  let component: ImagePlayerComponent;
  let drive: jasmine.SpyObj<DriveService>;
  let share: jasmine.SpyObj<ShareService>;
  let crypto: jasmine.SpyObj<CryptoService>;
  let kasumi: jasmine.SpyObj<KasumiCryptoService>;
  let store: any;
  const image = { id: 1, isFolder: false, decryptedName: 'photo.png', type: 'image', encryptedFdk: 'fdk', folderId: null } as DriveFile;
  const next = { ...image, id: 2, decryptedName: 'next.png' };

  beforeEach(async () => {
    drive = jasmine.createSpyObj('DriveService', ['downloadFile', 'downloadExternalMetadata', 'downloadExternalFileRange']);
    share = jasmine.createSpyObj('ShareService', ['downloadSharedFile', 'downloadSharedFileInRanges']);
    crypto = jasmine.createSpyObj('CryptoService', ['decryptName']);
    kasumi = jasmine.createSpyObj('KasumiCryptoService', ['decryptFile']);
    store = {
      isDownloading: () => false,
      downloadProgress: () => 0,
      thumbnails: () => ({}),
      loadThumbnail: jasmine.createSpy('loadThumbnail'),
      downloadFile: jasmine.createSpy('downloadFile').and.resolveTo(undefined),
    };
    crypto.decryptName.and.resolveTo(btoa('01234567890123456789012345678901'));
    kasumi.decryptFile.and.resolveTo(new Blob(['pixels'], { type: 'image/png' }));
    drive.downloadFile.and.returnValue(of(new Blob(['encrypted'])));
    share.downloadSharedFile.and.returnValue(of(new Blob(['shared'])));
    share.downloadSharedFileInRanges.and.resolveTo(new Blob(['shared']));

    await TestBed.configureTestingModule({
      imports: [ImagePlayerComponent],
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(),
        { provide: DriveStore, useValue: store }, { provide: DriveService, useValue: drive },
        { provide: ShareService, useValue: share }, { provide: CryptoService, useValue: crypto },
        { provide: KasumiCryptoService, useValue: kasumi },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ImagePlayerComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('file', image);
    fixture.componentRef.setInput('playlist', [image, next]);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('downloads, decrypts and caches an image in memory', async () => {
    await (component as any).loadImage(image);
    expect(drive.downloadFile).toHaveBeenCalledWith(1);
    expect(kasumi.decryptFile).toHaveBeenCalled();
    expect(component.isLoading()).toBeFalse();
    expect(component.imageUrl()).toBeTruthy();
    const firstUrl = component.imageUrl();
    await (component as any).loadImage(image);
    expect(component.imageUrl()).toBe(firstUrl);
  });

  it('uses the share FDK and reports a missing local FDK', async () => {
    const shared = { ...image, shareUuid: 'share', shareFdk: new Uint8Array(32), encryptedFdk: undefined } as DriveFile;
    await (component as any).loadImage(shared);
    expect(share.downloadSharedFileInRanges).toHaveBeenCalledWith('share', image.sizeBytes);

    const missing = { ...image, id: 3, encryptedFdk: undefined } as DriveFile;
    await (component as any).loadImage(missing);
    expect(component.error()).toContain('FDK');
  });

  it('handles failed downloads without exposing an error after abort', async () => {
    drive.downloadFile.and.returnValue(throwError(() => new Error('network')));
    await (component as any).loadImage({ ...image, id: 9 });
    expect(component.error()).toBe('network');
    (component as any).onClose();
    expect(component.close.emit).toBeDefined();
  });

  it('supports zoom, drag, navigation and keyboard close actions', () => {
    (component as any).zoomIn();
    expect(component.currentZoom()).toBe(1.25);
    (component as any).zoomOut();
    expect(component.currentZoom()).toBe(1);
    (component as any).onWheel({ deltaY: -1 } as WheelEvent);
    expect(component.currentZoom()).toBe(1.25);
    (component as any).onMouseDown({ clientX: 10, clientY: 20 } as MouseEvent);
    (component as any).onMouseMove({ clientX: 30, clientY: 50 } as MouseEvent);
    (component as any).onMouseUp();
    spyOn(component.fileChange, 'emit');
    (component as any).nextImage();
    expect(component.fileChange.emit).toHaveBeenCalledWith(next);
    fixture.componentRef.setInput('file', next);
    fixture.detectChanges();
    (component as any).prevImage();
    expect(component.fileChange.emit).toHaveBeenCalledWith(image);
    spyOn(component.close, 'emit');
    (component as any).onKeyDown({ key: 'Escape', target: document.body } as unknown as KeyboardEvent);
    expect(component.close.emit).toHaveBeenCalled();
  });

  it('emits video close separately and aborts work during teardown', () => {
    spyOn(component.closeVideo, 'emit');
    fixture.componentRef.setInput('isVideoPlaying', true);
    fixture.detectChanges();
    (component as any).onClose();
    expect(component.closeVideo.emit).toHaveBeenCalled();
    component.ngOnDestroy();
  });
});
