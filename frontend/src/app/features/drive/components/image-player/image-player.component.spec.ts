import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
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
  const image = { id: 1, isFolder: false, decryptedName: 'photo.png', type: 'image', encryptedFdk: 'fdk', sizeBytes: 100, folderId: null } as DriveFile;
  const next = { ...image, id: 2, decryptedName: 'next.png' };
  const mib = 1024 * 1024;

  function cachedImage(sourceBytes: number) {
    const cleanup = jasmine.createSpy(`cleanup-${sourceBytes}`);
    return {
      entry: { url: `blob:${sourceBytes}`, sourceBytes, cleanup },
      cleanup,
    };
  }

  beforeEach(async () => {
    drive = jasmine.createSpyObj('DriveService', ['downloadFile', 'downloadFileInRanges', 'downloadExternalMetadata', 'downloadExternalFileRange']);
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
    drive.downloadFileInRanges.and.resolveTo(new Blob(['encrypted']));
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
    expect(drive.downloadFileInRanges).toHaveBeenCalledWith(1, 100, jasmine.any(AbortSignal));
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
    expect(share.downloadSharedFileInRanges).toHaveBeenCalledWith('share', image.sizeBytes, undefined, jasmine.any(AbortSignal));

    const missing = { ...image, id: 3, encryptedFdk: undefined } as DriveFile;
    await (component as any).loadImage(missing);
    expect(component.error()).toContain('FDK');
  });

  it('uses the generic visualizer for MIME-detected images and audio', () => {
    const genericImage = { ...image, id: 20, type: 'generic', mimeType: 'image/png' } as DriveFile;
    fixture.componentRef.setInput('file', genericImage);
    fixture.detectChanges();
    expect(component.previewKind()).toBe('image');
    expect(fixture.nativeElement.querySelector('.no-preview-wrapper')).toBeNull();

    const audio = { ...image, id: 21, type: 'generic', mimeType: 'audio/mpeg', decryptedName: 'song.mp3' } as DriveFile;
    fixture.componentRef.setInput('file', audio);
    fixture.detectChanges();
    expect(component.previewKind()).toBe('audio');
    expect(fixture.nativeElement.querySelector('app-audio-player')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Nenhuma visualização disponível');
  });

  it('does not open sharing for a private Google Drive file', () => {
    fixture.componentRef.setInput('file', { ...image, storageProvider: 'google_drive' });
    fixture.detectChanges();
    const shareButton = fixture.nativeElement.querySelector('.share-btn') as HTMLButtonElement;
    expect(shareButton.disabled).toBeTrue();
    shareButton.click();
    expect(component.isShareOpen()).toBeFalse();
  });

  it('handles failed downloads without exposing an error after abort', async () => {
    drive.downloadFileInRanges.and.returnValue(Promise.reject(new Error('network')));
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

  it('prefetches only the immediate image neighbors', () => {
    const load = spyOn((component as any).mediaLoader, 'load').and.returnValue(new Promise(() => {}));
    const playlist = Array.from({ length: 13 }, (_, id) => ({
      ...image,
      id: id + 1,
      decryptedName: `image-${id + 1}.png`,
      sizeBytes: 1,
    } as DriveFile));
    fixture.componentRef.setInput('playlist', playlist);
    fixture.componentRef.setInput('file', playlist[6]);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).prefetchInFlight.clear();
    load.calls.reset();

    (component as any).prefetchAdjacentImages();

    expect(load.calls.allArgs().map(args => (args[0] as DriveFile).id)).toEqual([6, 8]);
  });

  it('does not start the second neighbor when the aggregate source budget would be exceeded', () => {
    const load = spyOn((component as any).mediaLoader, 'load').and.returnValue(new Promise(() => {}));
    const previous = { ...image, id: 10, decryptedName: 'previous.png', sizeBytes: 20 * 1024 * 1024 } as DriveFile;
    const current = { ...image, id: 11, decryptedName: 'current.png', sizeBytes: 1 } as DriveFile;
    const nextFile = { ...image, id: 12, decryptedName: 'next.png', sizeBytes: 13 * 1024 * 1024 } as DriveFile;
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).prefetchInFlight.clear();
    load.calls.reset();

    (component as any).prefetchAdjacentImages();

    expect(load.calls.allArgs().map(args => (args[0] as DriveFile).id)).toEqual([10]);
  });

  it('allows an oversized foreground but evicts it when it becomes speculative', () => {
    const foreground = { ...image, id: 60, sizeBytes: 100 * mib } as DriveFile;
    const nextFile = { ...image, id: 61, sizeBytes: 1 } as DriveFile;
    const cached = cachedImage(foreground.sizeBytes);
    fixture.componentRef.setInput('playlist', [foreground, nextFile]);
    fixture.componentRef.setInput('file', foreground);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(foreground.id, cached.entry);

    (component as any).pruneImageCache(foreground);
    expect((component as any).imageCache.has(foreground.id)).toBeTrue();

    (component as any).pruneImageCache(nextFile);

    expect((component as any).imageCache.has(foreground.id)).toBeFalse();
    expect(cached.cleanup).toHaveBeenCalledTimes(1);
  });

  it('allows a 100 MiB image to load as the foreground', async () => {
    const foreground = { ...image, id: 59, sizeBytes: 100 * mib } as DriveFile;
    const cleanup = jasmine.createSpy('foreground-cleanup');
    spyOn((component as any).mediaLoader, 'load').and.resolveTo({
      url: 'blob:foreground', mimeType: 'image/png', cleanup,
    });
    fixture.componentRef.setInput('playlist', [foreground]);
    fixture.componentRef.setInput('file', foreground);
    fixture.detectChanges();
    (component as any).imageCache.clear();

    await (component as any).loadImage(foreground);

    expect(component.imageUrl()).toBe('blob:foreground');
    expect((component as any).imageCache.has(foreground.id)).toBeTrue();
  });

  it('allows an unknown-size foreground but evicts it when it becomes speculative', () => {
    const foreground = { ...image, id: 62, sizeBytes: 0 } as DriveFile;
    const nextFile = { ...image, id: 63, sizeBytes: 1 } as DriveFile;
    const cached = cachedImage(0);
    fixture.componentRef.setInput('playlist', [foreground, nextFile]);
    fixture.componentRef.setInput('file', foreground);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(foreground.id, cached.entry);

    (component as any).pruneImageCache(nextFile);

    expect((component as any).imageCache.has(foreground.id)).toBeFalse();
    expect(cached.cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains adjacent neighbors up to the exact 32 MiB budget', () => {
    const previous = { ...image, id: 70, sizeBytes: 16 * mib } as DriveFile;
    const current = { ...image, id: 71, sizeBytes: 1 } as DriveFile;
    const nextFile = { ...image, id: 72, sizeBytes: 16 * mib } as DriveFile;
    const previousCached = cachedImage(previous.sizeBytes);
    const nextCached = cachedImage(nextFile.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, previousCached.entry);
    (component as any).imageCache.set(nextFile.id, nextCached.entry);

    (component as any).pruneImageCache(current);

    expect((component as any).imageCache.has(previous.id)).toBeTrue();
    expect((component as any).imageCache.has(nextFile.id)).toBeTrue();
    expect(previousCached.cleanup).not.toHaveBeenCalled();
    expect(nextCached.cleanup).not.toHaveBeenCalled();
  });

  it('keeps the previous neighbor before the next when the retained budget is exceeded', () => {
    const previous = { ...image, id: 73, sizeBytes: 20 * mib } as DriveFile;
    const current = { ...image, id: 74, sizeBytes: 1 } as DriveFile;
    const nextFile = { ...image, id: 75, sizeBytes: 12 * mib + 1 } as DriveFile;
    const previousCached = cachedImage(previous.sizeBytes);
    const nextCached = cachedImage(nextFile.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, previousCached.entry);
    (component as any).imageCache.set(nextFile.id, nextCached.entry);

    (component as any).pruneImageCache(current);

    expect((component as any).imageCache.has(previous.id)).toBeTrue();
    expect((component as any).imageCache.has(nextFile.id)).toBeFalse();
    expect(nextCached.cleanup).toHaveBeenCalledTimes(1);
  });

  it('evicts the next neighbor when both retained neighbors exceed the budget', () => {
    const previous = { ...image, id: 76, sizeBytes: 20 * mib } as DriveFile;
    const current = { ...image, id: 77, sizeBytes: 1 } as DriveFile;
    const nextFile = { ...image, id: 78, sizeBytes: 20 * mib } as DriveFile;
    const previousCached = cachedImage(previous.sizeBytes);
    const nextCached = cachedImage(nextFile.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, previousCached.entry);
    (component as any).imageCache.set(nextFile.id, nextCached.entry);

    (component as any).pruneImageCache(current);

    expect((component as any).imageCache.has(previous.id)).toBeTrue();
    expect((component as any).imageCache.has(nextFile.id)).toBeFalse();
    expect(nextCached.cleanup).toHaveBeenCalledTimes(1);
  });

  it('evicts a retained neighbor above the exact budget boundary', () => {
    const previous = { ...image, id: 79, sizeBytes: 32 * mib + 1 } as DriveFile;
    const current = { ...image, id: 80, sizeBytes: 1 } as DriveFile;
    const cached = cachedImage(previous.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, cached.entry);

    (component as any).pruneImageCache(current);

    expect((component as any).imageCache.has(previous.id)).toBeFalse();
    expect(cached.cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains a single neighbor at exactly 32 MiB', () => {
    const previous = { ...image, id: 805, sizeBytes: 32 * mib } as DriveFile;
    const current = { ...image, id: 806, sizeBytes: 1 } as DriveFile;
    const cached = cachedImage(previous.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, cached.entry);

    (component as any).pruneImageCache(current);

    expect((component as any).imageCache.has(previous.id)).toBeTrue();
    expect(cached.cleanup).not.toHaveBeenCalled();
  });

  it('keeps an unknown-size current foreground while retaining bounded neighbors', () => {
    const previous = { ...image, id: 807, sizeBytes: 16 * mib } as DriveFile;
    const current = { ...image, id: 808, sizeBytes: 0 } as DriveFile;
    const nextFile = { ...image, id: 809, sizeBytes: 16 * mib } as DriveFile;
    const previousCached = cachedImage(previous.sizeBytes);
    const currentCached = cachedImage(current.sizeBytes);
    const nextCached = cachedImage(nextFile.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, previousCached.entry);
    (component as any).imageCache.set(current.id, currentCached.entry);
    (component as any).imageCache.set(nextFile.id, nextCached.entry);

    (component as any).pruneImageCache(current);

    expect((component as any).imageCache.size).toBe(3);
    expect(currentCached.cleanup).not.toHaveBeenCalled();
  });

  it('does not clean an evicted cache entry again when pruning is repeated', () => {
    const previous = { ...image, id: 810, sizeBytes: 32 * mib + 1 } as DriveFile;
    const current = { ...image, id: 811, sizeBytes: 1 } as DriveFile;
    const cached = cachedImage(previous.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, cached.entry);

    (component as any).pruneImageCache(current);
    (component as any).pruneImageCache(current);

    expect(cached.cleanup).toHaveBeenCalledTimes(1);
  });

  it('uses retained bytes when deciding whether a 12 MiB neighbor can start', () => {
    const load = spyOn((component as any).mediaLoader, 'load').and.returnValue(new Promise(() => {}));
    const previous = { ...image, id: 812, sizeBytes: 20 * mib } as DriveFile;
    const current = { ...image, id: 813, sizeBytes: 1 } as DriveFile;
    const nextFile = { ...image, id: 814, sizeBytes: 12 * mib } as DriveFile;
    const previousCached = cachedImage(previous.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).prefetchInFlight.clear();
    (component as any).imageCache.set(previous.id, previousCached.entry);
    load.calls.reset();

    (component as any).prefetchAdjacentImages();

    expect(load.calls.allArgs().map(args => (args[0] as DriveFile).id)).toEqual([814]);
  });

  it('does not start a 13 MiB neighbor when 20 MiB is already retained', () => {
    const load = spyOn((component as any).mediaLoader, 'load').and.returnValue(new Promise(() => {}));
    const previous = { ...image, id: 815, sizeBytes: 20 * mib } as DriveFile;
    const current = { ...image, id: 816, sizeBytes: 1 } as DriveFile;
    const nextFile = { ...image, id: 817, sizeBytes: 13 * mib } as DriveFile;
    const previousCached = cachedImage(previous.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).prefetchInFlight.clear();
    (component as any).imageCache.set(previous.id, previousCached.entry);
    load.calls.reset();

    (component as any).prefetchAdjacentImages();

    expect(load).not.toHaveBeenCalled();
  });

  it('does not count the oversized current foreground against retained neighbors', () => {
    const previous = { ...image, id: 81, sizeBytes: 16 * mib } as DriveFile;
    const current = { ...image, id: 82, sizeBytes: 100 * mib } as DriveFile;
    const nextFile = { ...image, id: 83, sizeBytes: 16 * mib } as DriveFile;
    const previousCached = cachedImage(previous.sizeBytes);
    const currentCached = cachedImage(current.sizeBytes);
    const nextCached = cachedImage(nextFile.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).imageCache.set(previous.id, previousCached.entry);
    (component as any).imageCache.set(current.id, currentCached.entry);
    (component as any).imageCache.set(nextFile.id, nextCached.entry);

    (component as any).pruneImageCache(current);

    expect((component as any).imageCache.size).toBe(3);
    expect(previousCached.cleanup).not.toHaveBeenCalled();
    expect(currentCached.cleanup).not.toHaveBeenCalled();
    expect(nextCached.cleanup).not.toHaveBeenCalled();
  });

  it('does not retain a former oversized foreground before admitting a new neighbor', () => {
    const load = spyOn((component as any).mediaLoader, 'load').and.returnValue(new Promise(() => {}));
    const previous = { ...image, id: 84, sizeBytes: 100 * mib } as DriveFile;
    const current = { ...image, id: 85, sizeBytes: 1 } as DriveFile;
    const nextFile = { ...image, id: 86, sizeBytes: 8 * mib } as DriveFile;
    const cached = cachedImage(previous.sizeBytes);
    fixture.componentRef.setInput('playlist', [previous, current, nextFile]);
    fixture.componentRef.setInput('file', current);
    fixture.detectChanges();
    (component as any).imageCache.clear();
    (component as any).prefetchInFlight.clear();
    (component as any).imageCache.set(previous.id, cached.entry);
    load.calls.reset();

    (component as any).prefetchAdjacentImages();

    expect(cached.cleanup).toHaveBeenCalledTimes(1);
    expect(load.calls.allArgs().map(args => (args[0] as DriveFile).id)).toEqual([86]);
  });

  it('does not prefetch full images while video owns the foreground', () => {
    const load = spyOn((component as any).mediaLoader, 'load').and.returnValue(new Promise(() => {}));
    const previous = { ...image, id: 20, decryptedName: 'previous.png' } as DriveFile;
    const video = { ...image, id: 21, type: 'video', decryptedName: 'movie.mp4' } as DriveFile;
    const nextFile = { ...image, id: 22, decryptedName: 'next.png' } as DriveFile;
    fixture.componentRef.setInput('playlist', [previous, video, nextFile]);
    fixture.componentRef.setInput('file', video);
    fixture.detectChanges();
    load.calls.reset();

    (component as any).prefetchAdjacentImages();

    expect(load).not.toHaveBeenCalled();
    expect(store.loadThumbnail).toHaveBeenCalledWith(video);
  });

  it('aborts the previous speculative session when the current file changes', () => {
    const first = { ...image, id: 30, decryptedName: 'first.png' } as DriveFile;
    const second = { ...image, id: 31, decryptedName: 'second.png' } as DriveFile;
    fixture.componentRef.setInput('playlist', [first, second]);
    fixture.componentRef.setInput('file', first);
    fixture.detectChanges();
    (component as any).prefetchAdjacentImages();
    const oldSignal = (component as any).prefetchAbortController.signal as AbortSignal;

    fixture.componentRef.setInput('file', second);
    fixture.detectChanges();

    expect(oldSignal.aborted).toBeTrue();
  });

  it('stores cleanup ownership and releases cached resources on destroy', async () => {
    const cleanup = jasmine.createSpy('cleanup');
    spyOn((component as any).mediaLoader, 'load').and.resolveTo({
      url: 'blob:image', mimeType: 'image/png', cleanup,
    });

    await (component as any).loadImage(image);
    expect((component as any).imageCache.get(image.id).cleanup).toBe(cleanup);

    component.ngOnDestroy();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale prefetch resource while preserving the replacement session', async () => {
    await (component as any).loadImage(image);
    let resolveOld!: (resource: { url: string; mimeType: string; cleanup: () => void }) => void;
    let resolveNew!: (resource: { url: string; mimeType: string; cleanup: () => void }) => void;
    const oldCleanup = jasmine.createSpy('old-prefetch-cleanup');
    const newCleanup = jasmine.createSpy('new-prefetch-cleanup');
    (component as any).clearImageCache();
    const load = spyOn((component as any).mediaLoader, 'load');
    load.and.returnValue(new Promise(resolve => resolveOld = resolve));
    const oldSession = (component as any).beginPrefetchSession();
    const oldLoad = (component as any).prefetchFile(next, oldSession.generation, oldSession.signal);

    load.and.returnValue(new Promise(resolve => resolveNew = resolve));
    const newSession = (component as any).beginPrefetchSession();
    const newLoad = (component as any).prefetchFile(next, newSession.generation, newSession.signal);
    resolveOld({ url: 'blob:old-prefetch', mimeType: 'image/png', cleanup: oldCleanup });
    await oldLoad;

    expect(oldSession.signal.aborted).toBeTrue();
    expect(newSession.signal.aborted).toBeFalse();
    expect((component as any).imageCache.has(next.id)).toBeFalse();
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    resolveNew({ url: 'blob:new-prefetch', mimeType: 'image/png', cleanup: newCleanup });
    await newLoad;
    expect((component as any).imageCache.get(next.id).url).toBe('blob:new-prefetch');
    expect(newCleanup).not.toHaveBeenCalled();
  });

  it('does not publish a stale foreground resource after switching to video', async () => {
    let resolveLoad!: (value: { url: string; mimeType: string; cleanup: () => void }) => void;
    const cleanup = jasmine.createSpy('cleanup');
    spyOn((component as any).mediaLoader, 'load').and.returnValue(new Promise(resolve => {
      resolveLoad = resolve;
    }));
    const foreground = { ...image, id: 40, decryptedName: 'foreground.png' } as DriveFile;
    const video = { ...image, id: 41, type: 'video', decryptedName: 'movie.mp4' } as DriveFile;
    fixture.componentRef.setInput('playlist', [foreground, video]);
    fixture.detectChanges();
    const pending = (component as any).loadImage(foreground);
    await Promise.resolve();
    const signal = (component as any).abortController.signal as AbortSignal;

    fixture.componentRef.setInput('file', video);
    fixture.detectChanges();
    resolveLoad({ url: 'blob:stale', mimeType: 'image/png', cleanup });
    await pending;

    expect(signal.aborted).toBeTrue();
    expect(component.imageUrl()).toBeNull();
    expect(cleanup).toHaveBeenCalled();
  });
});
