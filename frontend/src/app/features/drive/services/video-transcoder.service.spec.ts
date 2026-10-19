import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { VideoTranscoderService } from './video-transcoder.service';

describe('VideoTranscoderService', () => {
  let service: VideoTranscoderService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), VideoTranscoderService]
    });
    service = TestBed.inject(VideoTranscoderService);
  });

  it('reuses an already loaded FFmpeg instance', async () => {
    const ffmpeg = {};
    (service as any).ffmpeg = ffmpeg;

    await expectAsync(service.loadFFmpeg()).toBeResolvedTo(ffmpeg as any);
  });

  it('detects videos by MIME type and supported filename extensions', () => {
    expect(service.isVideo(new File([], 'clip.bin', { type: 'video/webm' }))).toBeTrue();
    expect(service.isVideo(new File([], 'clip.MKV'))).toBeTrue();
    expect(service.isVideo(new File([], 'notes.txt', { type: 'text/plain' }))).toBeFalse();
  });

  it('accepts only native MP4 and WebM formats', () => {
    expect(service.isFormatNativelySupported(new File([], 'clip.MP4'))).toBeTrue();
    expect(service.isFormatNativelySupported(new File([], 'clip.webm'))).toBeTrue();
    expect(service.isFormatNativelySupported(new File([], 'clip.mov'))).toBeFalse();
    expect(service.isFormatNativelySupported(new File([], 'clip'))).toBeFalse();
  });

  it('reads finite video duration from metadata and releases the object URL', async () => {
    const video = {
      duration: 12.5,
      addEventListener: jasmine.createSpy('addEventListener'),
      removeEventListener: jasmine.createSpy('removeEventListener')
    } as any;
    spyOn(document, 'createElement').and.returnValue(video);
    spyOn(URL, 'createObjectURL').and.returnValue('blob:video');
    const revoke = spyOn(URL, 'revokeObjectURL');

    const durationPromise = service.getVideoDuration(new File([], 'clip.mp4'));
    const onMetadata = video.addEventListener.calls.argsFor(0)[1];
    onMetadata();

    await expectAsync(durationPromise).toBeResolvedTo(12.5);
    expect(revoke).toHaveBeenCalledWith('blob:video');
  });

  it('returns null when browser metadata loading fails or duration is not finite', async () => {
    const video = {
      duration: Infinity,
      addEventListener: jasmine.createSpy('addEventListener'),
      removeEventListener: jasmine.createSpy('removeEventListener')
    } as any;
    spyOn(document, 'createElement').and.returnValue(video);
    spyOn(URL, 'createObjectURL').and.returnValue('blob:video');
    spyOn(URL, 'revokeObjectURL');

    const durationPromise = service.getVideoDuration(new File([], 'clip.mp4'));
    const onError = video.addEventListener.calls.argsFor(1)[1];
    onError();

    await expectAsync(durationPromise).toBeResolvedTo(null);
  });
});
