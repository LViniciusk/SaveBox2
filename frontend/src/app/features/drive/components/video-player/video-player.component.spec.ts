import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VideoPlayerComponent } from './video-player.component';
import { VideoStreamService } from '../../services/video-stream.service';
import { DriveFile } from '../../state/drive.store';

describe('VideoPlayerComponent', () => {
  let fixture: ComponentFixture<VideoPlayerComponent>;
  let component: VideoPlayerComponent;
  let stream: jasmine.SpyObj<VideoStreamService>;
  let video: HTMLVideoElement;

  const file = { id: 1, isFolder: false, decryptedName: 'clip.mp4', type: 'video' } as DriveFile;

  beforeEach(async () => {
    stream = jasmine.createSpyObj('VideoStreamService', ['initializeStream', 'destroyStream']);
    Object.assign(stream, {
      error: () => null,
      isStreaming: () => false,
      isBuffering: () => false,
      originalBitrateWarning: () => false,
      bufferProgress: () => 0,
      isSeeking: () => false,
    });
    await TestBed.configureTestingModule({
      imports: [VideoPlayerComponent],
      providers: [provideZonelessChangeDetection(), { provide: VideoStreamService, useValue: stream }],
    }).compileComponents();

    fixture = TestBed.createComponent(VideoPlayerComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('file', file);
    fixture.detectChanges();
    video = document.createElement('video');
    Object.defineProperty(video, 'play', { value: jasmine.createSpy('play').and.resolveTo(undefined) });
    Object.defineProperty(video, 'pause', { value: jasmine.createSpy('pause') });
    (component as any).videoElement = { nativeElement: video };
    (component as any).playerBackdrop = { nativeElement: document.createElement('div') };
    stream.initializeStream.calls.reset();
  });

  it('starts and destroys the stream with the component lifecycle', () => {
    (component as any).startStream();
    expect(stream.initializeStream).toHaveBeenCalledWith(video, file);
    component.ngOnDestroy();
    expect(stream.destroyStream).toHaveBeenCalled();
  });

  it('calculates a bounded progress percentage', () => {
    component.duration.set(10);
    component.currentTime.set(7);
    expect(component.progressPercent()).toBe(70);
    component.currentTime.set(20);
    expect(component.progressPercent()).toBe(100);
    component.duration.set(0);
    expect(component.progressPercent()).toBe(0);
  });

  it('handles play, pause, seek, skip and volume controls', () => {
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    (component as any).togglePlay();
    expect(video.play).toHaveBeenCalled();

    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    (component as any).togglePlay();
    expect(video.pause).toHaveBeenCalled();

    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 50, writable: true, configurable: true });
    (component as any).skip(60);
    expect(video.currentTime).toBe(100);
    (component as any).skip(-200);
    expect(video.currentTime).toBe(0);

    (component as any).changeVolume(0.5);
    expect(component.volume()).toBe(1);
    (component as any).changeVolumeTo(0);
    expect(video.muted).toBeTrue();
    expect((component as any).getVolumeIcon()).toBe('volume_off');
    (component as any).toggleMute();
    expect(component.isMuted()).toBeFalse();
  });

  it('updates media state and formats time across boundaries', () => {
    Object.defineProperty(video, 'duration', { value: 125, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 25, configurable: true });
    Object.defineProperty(video, 'volume', { value: 0.25, writable: true, configurable: true });
    Object.defineProperty(video, 'muted', { value: false, writable: true, configurable: true });
    (component as any).onLoadedMetadata();
    (component as any).onTimeUpdate();
    expect(component.duration()).toBe(125);
    expect(component.currentTime()).toBe(25);
    expect((component as any).getVolumeIcon()).toBe('volume_down');
    expect((component as any).formatTime(3661)).toBe('1:01:01');
    expect((component as any).formatTime(61)).toBe('1:01');
    expect((component as any).formatTime(NaN)).toBe('0:00');
  });

  it('responds to keyboard shortcuts and emits user actions', () => {
    spyOn(component.close, 'emit');
    spyOn(component.download, 'emit');
    spyOn(component.videoReady, 'emit');
    const preventDefault = jasmine.createSpy('preventDefault');
    (component as any).handleKeyDown({ key: 'm', target: document.body, preventDefault });
    (component as any).handleKeyDown({ key: 'ArrowRight', target: document.body, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    (component as any).onClose();
    (component as any).downloadVideo();
    expect(component.close.emit).toHaveBeenCalled();
    expect(component.download.emit).toHaveBeenCalled();
  });

  it('ignores shortcuts originating in text inputs and keeps fullscreen state observable', () => {
    const preventDefault = jasmine.createSpy('preventDefault');
    (component as any).handleKeyDown({ key: 'f', target: document.createElement('input'), preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    spyOn(document, 'exitFullscreen').and.returnValue(Promise.resolve());
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    (component as any).onFullscreenChange();
    expect(component.isFullscreen()).toBeFalse();
  });

  it('updates buffer, seeks through inputs, and tracks volume changes', () => {
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 10, writable: true, configurable: true });
    Object.defineProperty(video, 'buffered', {
      value: { length: 1, end: () => 40 }, configurable: true
    });
    (component as any).onTimeUpdate();
    expect(component.bufferedAmount()).toBe(40);
    const seek = { target: { value: '75' } } as any;
    (component as any).onSeek(seek);
    expect(video.currentTime).toBe(75);
    Object.defineProperty(video, 'volume', { value: 0.25, writable: true, configurable: true });
    Object.defineProperty(video, 'muted', { value: true, writable: true, configurable: true });
    (component as any).onVolumeChange();
    expect(component.volume()).toBe(0.25);
    expect(component.isMuted()).toBeTrue();
    (component as any).onVolumeInput({ target: { value: '0.8' } });
    expect(component.volume()).toBe(0.8);
  });

  it('changes playback speed and responds to mouse visibility and flash timers', () => {
    (component as any).setSpeed(1.5);
    expect(video.playbackRate).toBe(1.5);
    expect(component.playbackSpeed()).toBe(1.5);
    expect(component.isSpeedMenuOpen()).toBeFalse();
    component.isPlaying.set(true);
    spyOn(video, 'getBoundingClientRect').and.returnValue({ left: 0, top: 0, right: 100, bottom: 100 } as DOMRect);
    (component as any).onMouseMove(new MouseEvent('mousemove', { clientX: 1000, clientY: 1000 }));
    expect(component.showControls()).toBeFalse();
    (component as any).onMouseMove(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }));
    expect(component.showControls()).toBeTrue();
    (component as any).onMouseLeave();
    expect(component.showControls()).toBeFalse();
    (component as any).triggerCenterFlash('pause');
    expect(component.centerFlashIcon()).toBe('pause');
  });

  it('uses fullscreen and picture-in-picture APIs when available', async () => {
    const backdrop = (component as any).playerBackdrop.nativeElement as HTMLElement;
    Object.defineProperty(backdrop, 'requestFullscreen', { value: jasmine.createSpy('requestFullscreen').and.resolveTo(undefined) });
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    (component as any).toggleFullscreen();
    expect((backdrop.requestFullscreen as jasmine.Spy)).toHaveBeenCalled();
    Object.defineProperty(document, 'fullscreenElement', { value: backdrop, configurable: true });
    spyOn(document, 'exitFullscreen').and.resolveTo();
    (component as any).toggleFullscreen();
    expect(document.exitFullscreen).toHaveBeenCalled();
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    Object.defineProperty(video, 'requestPictureInPicture', { value: jasmine.createSpy('pip').and.resolveTo({}) });
    Object.defineProperty(document, 'pictureInPictureElement', { value: null, configurable: true });
    (component as any).togglePiP();
    expect((video.requestPictureInPicture as jasmine.Spy)).toHaveBeenCalled();
  });

  it('marks readiness after enough buffered data and retries playback', () => {
    const play = video.play as jasmine.Spy;
    Object.defineProperty(video, 'buffered', { value: { length: 1, end: () => 10 }, configurable: true });
    Object.defineProperty(video, 'duration', { value: 20, configurable: true });
    (component as any).ngAfterViewInit();
    const canPlay = new Event('canplay');
    video.dispatchEvent(canPlay);
    expect(stream.initializeStream).toHaveBeenCalled();
    (component as any).retryPlayback();
    expect(stream.initializeStream.calls.count()).toBeGreaterThan(1);
    expect(play).toBeDefined();
  });
});
