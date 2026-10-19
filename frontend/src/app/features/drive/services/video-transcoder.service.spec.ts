import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { VideoTranscoderService } from './video-transcoder.service';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeFfmpeg() {
  return {
    load: jasmine.createSpy('load').and.resolveTo(true),
    writeFile: jasmine.createSpy('writeFile').and.resolveTo(),
    exec: jasmine.createSpy('exec').and.resolveTo(),
    readFile: jasmine.createSpy('readFile').and.resolveTo(new Uint8Array([1, 2, 3])),
    deleteFile: jasmine.createSpy('deleteFile').and.resolveTo(),
    on: jasmine.createSpy('on'),
    off: jasmine.createSpy('off'),
    terminate: jasmine.createSpy('terminate')
  };
}

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

  it('B.71.A shares one in-flight FFmpeg initialization across concurrent callers', async () => {
    const loadGate = deferred<boolean>();
    const instances = [fakeFfmpeg(), fakeFfmpeg(), fakeFfmpeg()];
    instances.forEach(instance => instance.load.and.returnValue(loadGate.promise));
    let created = 0;
    spyOn(service as any, 'createFFmpeg').and.callFake(() => instances[created++]);

    const first = service.loadFFmpeg();
    const second = service.loadFFmpeg();
    const third = service.loadFFmpeg();

    loadGate.resolve(true);
    const [firstFfmpeg, secondFfmpeg, thirdFfmpeg] = await Promise.all([first, second, third]);

    expect(instances.filter(instance => instance.load).reduce((count, instance) => count + instance.load.calls.count(), 0)).toBe(1);
    expect(firstFfmpeg).toBe(secondFfmpeg);
    expect(secondFfmpeg).toBe(thirdFfmpeg);
  });

  it('B.71.A retries FFmpeg initialization after an in-flight load failure', async () => {
    const firstGate = deferred<boolean>();
    const secondGate = deferred<boolean>();
    let attempt = 1;
    const instances = [fakeFfmpeg(), fakeFfmpeg(), fakeFfmpeg()];
    instances.forEach(instance => instance.load.and.callFake(() => (
      attempt === 1 ? firstGate.promise : secondGate.promise
    )));
    let created = 0;
    spyOn(service as any, 'createFFmpeg').and.callFake(() => instances[created++]);
    const loadError = new Error('load failed');

    const first = service.loadFFmpeg();
    const second = service.loadFFmpeg();
    firstGate.reject(loadError);

    const failures = await Promise.allSettled([first, second]);
    expect(failures[0].status).toBe('rejected');
    expect(failures[1].status).toBe('rejected');
    if (failures[0].status === 'rejected' && failures[1].status === 'rejected') {
      expect(failures[0].reason).toBe(loadError);
      expect(failures[1].reason).toBe(loadError);
    }

    attempt = 2;
    const retry = service.loadFFmpeg();
    secondGate.resolve(true);
    await expectAsync(retry).toBeResolved();
    expect(instances.reduce((count, instance) => count + instance.load.calls.count(), 0)).toBe(2);
  });

  it('B.71.A serializes concurrent FFmpeg transcodes and completes cleanup before the next job', async () => {
    const firstTranscodeGate = deferred<void>();
    const firstTranscodeStarted = deferred<void>();
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let transcodeCalls = 0;
    spyOn(service as any, 'transcodeToProxyExclusive').and.callFake(async (inputFile: File) => {
      transcodeCalls++;
      events.push(`start:${inputFile.name}`);
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (transcodeCalls === 1) {
        firstTranscodeStarted.resolve();
        await firstTranscodeGate.promise;
      }
      active--;
      events.push(`cleanup:${inputFile.name}`);
      return inputFile;
    });

    const first = service.transcodeToProxy(new File(['a'], 'first.mkv'), 'pure');
    const second = service.transcodeToProxy(new File(['b'], 'second.mkv'), 'pure');

    await firstTranscodeStarted.promise;
    firstTranscodeGate.resolve();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
    expect(events.indexOf('start:second.mkv')).toBeGreaterThan(events.indexOf('cleanup:first.mkv'));
  });

  it('B.71.A releases the transcode queue after a failure and preserves the caller error', async () => {
    const ffmpeg = fakeFfmpeg();
    const transcodeError = new Error('transcode failed');
    let execCalls = 0;
    ffmpeg.exec.and.callFake(async () => {
      execCalls++;
      if (execCalls === 1) throw transcodeError;
    });
    spyOn(service, 'loadFFmpeg').and.resolveTo(ffmpeg as any);

    const first = service.transcodeToProxy(new File(['a'], 'first.mkv'), 'pure');
    const second = service.transcodeToProxy(new File(['b'], 'second.mkv'), 'pure');

    await expectAsync(first).toBeRejectedWith(transcodeError);
    await expectAsync(second).toBeResolved();
    expect(execCalls).toBe(2);
    expect(ffmpeg.off).toHaveBeenCalledTimes(2);
  });

  describe('B.92 cancellation ownership', () => {
    let ffmpeg: ReturnType<typeof fakeFfmpeg>;
    let create: jasmine.Spy;
    const input = () => new File(['video'], 'synthetic.mkv');

    beforeEach(() => {
      ffmpeg = fakeFfmpeg();
      create = spyOn(service as any, 'createFFmpeg').and.returnValue(ffmpeg);
    });

    it('rejects pre-aborted jobs before acquiring FFmpeg or publishing progress', async () => {
      const controller = new AbortController();
      controller.abort();
      const progress = jasmine.createSpy('progress');
      const result = service.transcodeToProxy(input(), 'pure', progress, controller.signal);

      await expectAsync(result).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));
      expect(create).not.toHaveBeenCalled();
      expect(ffmpeg.load).not.toHaveBeenCalled();
      expect(ffmpeg.writeFile).not.toHaveBeenCalled();
      expect(ffmpeg.exec).not.toHaveBeenCalled();
      expect(ffmpeg.readFile).not.toHaveBeenCalled();
      expect(ffmpeg.deleteFile).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();
    });

    for (const method of ['writeFile', 'exec', 'readFile'] as const) {
      it(`terminates the active engine during ${method} and suppresses late progress and output`, async () => {
        const gate = deferred<any>();
        const started = deferred<void>();
        ffmpeg[method].and.callFake(() => {
          started.resolve();
          return gate.promise;
        });
        ffmpeg.terminate.and.callFake(() => gate.reject(new Error('terminated')));
        const controller = new AbortController();
        const progress = jasmine.createSpy('progress');
        const outcome = service.transcodeToProxy(input(), 'pure', progress, controller.signal)
          .then(() => 'SUCCESS', (error: Error) => error.name);

        await started.promise;
        controller.abort();
        expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
        const progressCalls = progress.calls.count();
        const handler = ffmpeg.on.calls.allArgs().find(([kind]) => kind === 'progress')?.[1];
        handler?.({ progress: 0.9, time: 1 });
        expect(progress.calls.count()).toBe(progressCalls);
        // Release the original implementation too, so the RED never depends on a timeout.
        gate.resolve(method === 'readFile' ? new Uint8Array([1]) : undefined);

        expect(await outcome).toBe('AbortError');
        if (method === 'writeFile') expect(ffmpeg.exec).not.toHaveBeenCalled();
        if (method !== 'readFile') expect(ffmpeg.readFile).not.toHaveBeenCalled();
        expect(ffmpeg.deleteFile).not.toHaveBeenCalled();
        expect(ffmpeg.off).toHaveBeenCalledOnceWith('progress', jasmine.any(Function));
        if (handler) expect(ffmpeg.off).toHaveBeenCalledWith('progress', handler);
      });
    }

    it('does not let a cancelled queued job acquire or terminate the active engine', async () => {
      const gate = deferred<void>();
      const started = deferred<void>();
      ffmpeg.exec.and.callFake(() => {
        started.resolve();
        return gate.promise;
      });
      const first = service.transcodeToProxy(input(), 'pure');
      await started.promise;
      const controller = new AbortController();
      const progress = jasmine.createSpy('queued progress');
      const second = service.transcodeToProxy(input(), 'pure', progress, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);

      controller.abort();
      expect(ffmpeg.terminate).not.toHaveBeenCalled();
      gate.resolve();
      await expectAsync(first).toBeResolved();
      expect(await second).toBe('AbortError');
      expect(ffmpeg.writeFile).toHaveBeenCalledTimes(1);
      expect(ffmpeg.exec).toHaveBeenCalledTimes(1);
      expect(ffmpeg.readFile).toHaveBeenCalledTimes(1);
      expect(ffmpeg.on.calls.allArgs().filter(([kind]) => kind === 'progress').length).toBe(1);
      expect(progress).not.toHaveBeenCalled();
    });

    it('releases the queue and loads a fresh engine after active cancellation', async () => {
      const next = fakeFfmpeg();
      create.and.returnValues(ffmpeg, next);
      const gate = deferred<void>();
      const started = deferred<void>();
      ffmpeg.exec.and.callFake(() => {
        started.resolve();
        return gate.promise;
      });
      ffmpeg.terminate.and.callFake(() => gate.reject(new Error('terminated')));
      const controller = new AbortController();
      const first = service.transcodeToProxy(input(), 'pure', undefined, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);
      await started.promise;
      const second = service.transcodeToProxy(input(), 'compressed');

      controller.abort();
      gate.resolve();
      expect(await first).toBe('AbortError');
      await expectAsync(second).toBeResolved();
      expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
      expect(ffmpeg.readFile).not.toHaveBeenCalled();
      expect(ffmpeg.deleteFile).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(2);
      expect(next.load).toHaveBeenCalledTimes(1);
      expect(next.exec).toHaveBeenCalledTimes(1);
      expect(next.terminate).not.toHaveBeenCalled();
      expect((service as any).ffmpeg).toBe(next);
    });

    it('cleans up a failed provisional load and allows a fresh shared initialization', async () => {
      const next = fakeFfmpeg();
      create.and.returnValues(ffmpeg, next);
      const failure = new Error('synthetic load failure');
      ffmpeg.load.and.rejectWith(failure);
      spyOn(console, 'error');

      const results = await Promise.allSettled([service.loadFFmpeg(), service.loadFFmpeg()]);
      expect(results.every(result => result.status === 'rejected' && result.reason === failure)).toBeTrue();
      expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
      expect((service as any).ffmpeg).toBeNull();
      expect((service as any).ffmpegLoadPromise).toBeNull();
      await expectAsync(service.loadFFmpeg()).toBeResolvedTo(next as any);
      expect(create).toHaveBeenCalledTimes(2);
      expect(next.terminate).not.toHaveBeenCalled();
    });

    it('revokes output after a non-preemptible fetchFile finishes without writing to FFmpeg', async () => {
      const reading = deferred<FileReader>();
      spyOn(FileReader.prototype, 'readAsArrayBuffer').and.callFake(function (this: FileReader) {
        reading.resolve(this);
      });
      const controller = new AbortController();
      const outcome = service.transcodeToProxy(input(), 'pure', undefined, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);
      const reader = await reading.promise;

      controller.abort();
      Object.defineProperty(reader, 'result', { value: new ArrayBuffer(1) });
      reader.onload?.call(reader, new ProgressEvent('load') as ProgressEvent<FileReader>);
      expect(await outcome).toBe('AbortError');
      expect(ffmpeg.writeFile).not.toHaveBeenCalled();
      expect(ffmpeg.exec).not.toHaveBeenCalled();
    });

    it('leaves shared initialization alive while a cancelled caller loses execution authority', async () => {
      const load = deferred<boolean>();
      const jobStarted = deferred<void>();
      ffmpeg.load.and.returnValue(load.promise);
      const shared = service.loadFFmpeg();
      const controller = new AbortController();
      const progress = jasmine.createSpy('progress').and.callFake(() => jobStarted.resolve());
      const outcome = service.transcodeToProxy(input(), 'pure', progress, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);
      await jobStarted.promise;

      controller.abort();
      const calls = progress.calls.count();
      load.resolve(true);
      await expectAsync(shared).toBeResolvedTo(ffmpeg as any);
      expect(await outcome).toBe('AbortError');
      expect(ffmpeg.terminate).not.toHaveBeenCalled();
      expect(ffmpeg.writeFile).not.toHaveBeenCalled();
      expect(progress.calls.count()).toBe(calls);
      await expectAsync(service.transcodeToProxy(input(), 'pure')).toBeResolved();
      expect(ffmpeg.load).toHaveBeenCalledTimes(1);
    });

    it('retains the live engine and removes the old signal listener before the next job', async () => {
      const controller = new AbortController();
      const remove = spyOn(controller.signal, 'removeEventListener').and.callThrough();
      await service.transcodeToProxy(input(), 'pure', undefined, controller.signal);
      const gate = deferred<void>();
      const started = deferred<void>();
      ffmpeg.exec.and.callFake(() => {
        started.resolve();
        return gate.promise;
      });
      const second = service.transcodeToProxy(input(), 'compressed');
      await started.promise;

      controller.abort();
      expect(ffmpeg.terminate).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledOnceWith('abort', jasmine.any(Function));
      gate.resolve();
      await expectAsync(second).toBeResolved();
      expect(create).toHaveBeenCalledTimes(1);
      expect(ffmpeg.load).toHaveBeenCalledTimes(1);
      expect(ffmpeg.deleteFile).toHaveBeenCalledTimes(4);
      const handlers = ffmpeg.on.calls.allArgs().filter(([kind]) => kind === 'progress');
      expect(handlers.length).toBe(2);
      for (const [, handler] of handlers) expect(ffmpeg.off).toHaveBeenCalledWith('progress', handler);
      expect(ffmpeg.exec.calls.argsFor(0)[0]).toEqual(jasmine.arrayContaining(['-crf', '18', '-preset', 'fast']));
      expect(ffmpeg.exec.calls.argsFor(1)[0]).toEqual(jasmine.arrayContaining(['-crf', '28', '-preset', 'veryfast']));
    });

    it('never invalidates or terminates a newer cached engine from an older owner', async () => {
      const gate = deferred<void>();
      const started = deferred<void>();
      ffmpeg.exec.and.callFake(() => {
        started.resolve();
        return gate.promise;
      });
      ffmpeg.terminate.and.callFake(() => gate.reject(new Error('terminated')));
      const controller = new AbortController();
      const outcome = service.transcodeToProxy(input(), 'pure', undefined, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);
      await started.promise;
      const newer = fakeFfmpeg();
      (service as any).ffmpeg = newer;

      controller.abort();
      gate.resolve();
      expect(await outcome).toBe('AbortError');
      expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
      expect(newer.terminate).not.toHaveBeenCalled();
      expect((service as any).ffmpeg).toBe(newer);
    });

    it('rejects an already resolved read result when abort wins its publication boundary', async () => {
      const read = deferred<Uint8Array>();
      const started = deferred<void>();
      ffmpeg.readFile.and.callFake(() => {
        started.resolve();
        return read.promise;
      });
      const controller = new AbortController();
      const outcome = service.transcodeToProxy(input(), 'pure', undefined, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);
      await started.promise;

      read.resolve(new Uint8Array([1]));
      controller.abort();
      expect(await outcome).toBe('AbortError');
      expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
      expect(ffmpeg.deleteFile).not.toHaveBeenCalled();
    });

    it('keeps cancellation authoritative until live temporary-file cleanup settles', async () => {
      const deletion = deferred<void>();
      const started = deferred<void>();
      ffmpeg.deleteFile.and.callFake(() => {
        started.resolve();
        return deletion.promise;
      });
      ffmpeg.terminate.and.callFake(() => deletion.reject(new Error('terminated')));
      const warn = spyOn(console, 'warn');
      const controller = new AbortController();
      const remove = spyOn(controller.signal, 'removeEventListener').and.callThrough();
      const outcome = service.transcodeToProxy(input(), 'pure', undefined, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);
      await started.promise;

      controller.abort();
      expect(await outcome).toBe('AbortError');
      expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
      expect(ffmpeg.deleteFile).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledOnceWith('abort', jasmine.any(Function));
      expect(warn).not.toHaveBeenCalled();
    });

    it('preserves a genuine execution failure and removes both listeners despite a cleanup failure', async () => {
      const failure = new Error('synthetic execution failure');
      ffmpeg.exec.and.rejectWith(failure);
      ffmpeg.deleteFile.and.rejectWith(new Error('synthetic cleanup failure'));
      const warn = spyOn(console, 'warn');
      const controller = new AbortController();
      const remove = spyOn(controller.signal, 'removeEventListener').and.callThrough();

      await expectAsync(service.transcodeToProxy(input(), 'pure', undefined, controller.signal))
        .toBeRejectedWith(failure);
      expect(ffmpeg.off).toHaveBeenCalledOnceWith('progress', jasmine.any(Function));
      expect(remove).toHaveBeenCalledOnceWith('abort', jasmine.any(Function));
      expect(warn).toHaveBeenCalledTimes(1);
      expect((service as any).ffmpeg).toBe(ffmpeg);
      controller.abort();
      expect(ffmpeg.terminate).not.toHaveBeenCalled();
    });

    it('keeps the caller cancelled and reports a sanitized unexpected termination failure', async () => {
      const exec = deferred<void>();
      const started = deferred<void>();
      ffmpeg.exec.and.callFake(() => {
        started.resolve();
        return exec.promise;
      });
      ffmpeg.terminate.and.callFake(() => {
        exec.reject(new Error('terminated'));
        throw new Error('synthetic worker termination failure');
      });
      const warn = spyOn(console, 'warn');
      const controller = new AbortController();
      const outcome = service.transcodeToProxy(input(), 'pure', undefined, controller.signal)
        .then(() => 'SUCCESS', (error: Error) => error.name);
      await started.promise;

      controller.abort();
      expect(await outcome).toBe('AbortError');
      expect(warn).toHaveBeenCalledOnceWith('[VideoTranscoder] Failed to terminate FFmpeg');
      expect((service as any).ffmpeg).toBeNull();
      expect(ffmpeg.readFile).not.toHaveBeenCalled();
    });

    it('uses the installed wrapper contract to reject pending calls and recreate a terminated worker', async () => {
      const workers = [0, 1].map(() => ({
        postMessage: jasmine.createSpy('postMessage'),
        terminate: jasmine.createSpy('worker terminate'),
        onmessage: null as ((event: MessageEvent) => void) | null,
      }));
      spyOn(window, 'Worker').and.returnValues(...workers as any);
      const wrapper = new FFmpeg();
      const loaded = wrapper.load({ classWorkerURL: '/synthetic-worker.js' });
      const loadMessage = workers[0].postMessage.calls.mostRecent().args[0];
      workers[0].onmessage!({ data: { ...loadMessage, data: true } } as MessageEvent);
      await loaded;
      const pending = [wrapper.exec([]), wrapper.writeFile('input', new Uint8Array()), wrapper.readFile('output')];
      const settled = Promise.allSettled(pending);

      wrapper.terminate();
      expect((await settled).every(result => result.status === 'rejected')).toBeTrue();
      expect(workers[0].terminate).toHaveBeenCalledTimes(1);
      expect(wrapper.loaded).toBeFalse();
      wrapper.off('progress', () => undefined);
      await expectAsync(wrapper.deleteFile('input')).toBeRejected();
      const reloaded = wrapper.load({ classWorkerURL: '/synthetic-worker.js' });
      const nextMessage = workers[1].postMessage.calls.mostRecent().args[0];
      workers[1].onmessage!({ data: { ...nextMessage, data: true } } as MessageEvent);
      await expectAsync(reloaded).toBeResolvedTo(true);
      expect(wrapper.loaded).toBeTrue();
      wrapper.terminate();
      expect(workers[1].terminate).toHaveBeenCalledTimes(1);
    });
  });

  it('detects videos by MIME type and supported filename extensions', () => {
    expect(service.isVideo(new File([], 'clip.bin', { type: 'video/webm' }))).toBeTrue();
    expect(service.isVideo(new File([], 'clip.MKV'))).toBeTrue();
    expect(service.isVideo(new File([], 'clip.webm'))).toBeTrue();
    expect(service.isVideo(new File([], 'CLIP.WEBM'))).toBeTrue();
    expect(service.isVideo(new File([], 'clip.webm', { type: 'application/octet-stream' }))).toBeTrue();
    expect(service.isVideo(new File([], 'notes.txt', { type: 'text/plain' }))).toBeFalse();
  });

  it('accepts only formats supported directly by the MP4 streaming pipeline', () => {
    const isStreamingFormatSupported = (file: File) =>
      (service as any).isStreamingFormatSupported(file) as boolean;

    expect(isStreamingFormatSupported(new File([], 'clip.MP4'))).toBeTrue();
    expect(isStreamingFormatSupported(new File([], 'clip.WEBM'))).toBeFalse();
    expect(isStreamingFormatSupported(new File([], 'clip.mov'))).toBeFalse();
    expect(isStreamingFormatSupported(new File([], 'clip'))).toBeFalse();
    const mimeLessWebm = new File([], 'clip.webm');
    const mimeLessMp4 = new File([], 'clip.mp4');
    expect(service.isVideo(mimeLessWebm)).toBeTrue();
    expect(isStreamingFormatSupported(mimeLessWebm)).toBeFalse();
    expect(service.isVideo(mimeLessMp4)).toBeTrue();
    expect(isStreamingFormatSupported(mimeLessMp4)).toBeTrue();
    expect(service.isVideo(new File([], 'clip.webm', { type: 'video/webm' }))).toBeTrue();
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
