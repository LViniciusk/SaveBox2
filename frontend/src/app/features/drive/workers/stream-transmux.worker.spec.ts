import { handleTransmuxReady } from './stream-transmux-ready';

type ReadyTrackInfo = Parameters<typeof handleTransmuxReady>[0];
type ReadyState = Parameters<typeof handleTransmuxReady>[1];
type ReadyMp4File = Parameters<typeof handleTransmuxReady>[2];

describe('stream-transmux ready phase', () => {
  function runReady(info: ReadyTrackInfo, initBuffer?: ArrayBuffer, startOnReady = true): {
    state: ReadyState;
    mp4file: jasmine.SpyObj<ReadyMp4File>;
  } {
    const state: ReadyState = {
      videoDuration: null,
      initData: null,
      resolveReady: null,
    };
    const mp4file = jasmine.createSpyObj<ReadyMp4File>('mp4file', [
      'setSegmentOptions',
      'initializeSegmentation',
      'start',
    ]);
    mp4file.initializeSegmentation.and.returnValue(initBuffer ? { buffer: initBuffer } : undefined);
    handleTransmuxReady(info, state, mp4file, startOnReady);
    return { state, mp4file };
  }

  function expectOptions(spy: jasmine.Spy, id: unknown): void {
    expect(spy).toHaveBeenCalledWith(id, null, { nbSamples: 35, rapAlignement: true });
  }

  it('updates duration only when duration and timescale are truthy', () => {
    const valid = runReady({ duration: 900, timescale: 30 });
    const missing = runReady({});
    const zeroDuration = runReady({ duration: 0, timescale: 30 });
    const zeroTimescale = runReady({ duration: 900, timescale: 0 });

    expect(valid.state.videoDuration).toBe(30);
    expect(missing.state.videoDuration).toBeNull();
    expect(zeroDuration.state.videoDuration).toBeNull();
    expect(zeroTimescale.state.videoDuration).toBeNull();
  });

  it('processes array tracks with exact options and raw codec values', () => {
    const { state, mp4file } = runReady({
      tracks: [
        { id: 1, codec: 'avc1.42E01E' },
        { id: 2, codec: 'mp4a.40.2' },
      ],
    });

    expect(mp4file.setSegmentOptions).toHaveBeenCalledTimes(2);
    expectOptions(mp4file.setSegmentOptions, 1);
    expectOptions(mp4file.setSegmentOptions, 2);
    expect(state.initData).toEqual([]);
  });

  it('supports object-like track collections and missing tracks', () => {
    const objectTracks = runReady({
      tracks: {
        first: { id: 1, codec: 'avc1.test' },
        second: { id: 2, codec: 'mp4a.test' },
      },
    });
    const missingTracks = runReady({});

    expect(objectTracks.mp4file.setSegmentOptions).toHaveBeenCalledTimes(2);
    expect(missingTracks.mp4file.setSegmentOptions).not.toHaveBeenCalled();
  });

  it('ignores invalid track entries while processing valid entries', () => {
    const { mp4file } = runReady({
      tracks: [null, undefined, 123, 'bad', false, { id: 7, codec: 'avc1.valid' }],
    });

    expect(mp4file.setSegmentOptions).toHaveBeenCalledOnceWith(7, null, { nbSamples: 35, rapAlignement: true });
  });

  it('uses metadata membership and String id coercion for video and audio', () => {
    const { mp4file } = runReady({
      tracks: [
        { id: 7, codec: 'mystery-video' },
        { id: '8', codec: 'mystery-audio' },
      ],
      videoTracks: [{ id: '7' }],
      audioTracks: [{ id: 8 }],
    });

    expectOptions(mp4file.setSegmentOptions, 7);
    expectOptions(mp4file.setSegmentOptions, '8');
  });

  it('recognizes all supported video and audio codec prefixes', () => {
    const { mp4file } = runReady({
      tracks: [
        { id: 1, codec: 'avc1.test' },
        { id: 2, codec: 'hev1.test' },
        { id: 3, codec: 'hvc1.test' },
        { id: 4, codec: 'vp09.test' },
        { id: 5, codec: 'mp4a.test' },
        { id: 6, codec: 'opus.test' },
        { id: 7, codec: 'flac.test' },
      ],
    });

    expect(mp4file.setSegmentOptions).toHaveBeenCalledTimes(7);
  });

  it('uses track flags and recognizes conflicting signals once', () => {
    const { mp4file } = runReady({
      tracks: [
        { id: 1, codec: 'unknown', video: true },
        { id: 2, codec: 'unknown', audio: true },
        { id: 3, codec: 'mp4a.conflict' },
      ],
      videoTracks: [{ id: 3 }],
      audioTracks: [{ id: 3 }],
    });

    expect(mp4file.setSegmentOptions).toHaveBeenCalledTimes(3);
  });

  it('skips unknown tracks without configuring segmentation', () => {
    const { mp4file } = runReady({ tracks: [{ id: 1, codec: 'unknown' }] });

    expect(mp4file.setSegmentOptions).not.toHaveBeenCalled();
  });

  it('preserves the unified MIME codecs for video-only, audio-only and mixed tracks', () => {
    const videoBuffer = new ArrayBuffer(1);
    const audioBuffer = new ArrayBuffer(1);
    const mixedBuffer = new ArrayBuffer(1);
    const video = runReady({ tracks: [{ id: 1, codec: 'avc1.video' }] }, videoBuffer);
    const audio = runReady({ tracks: [{ id: 1, codec: 'mp4a.audio' }] }, audioBuffer);
    const mixed = runReady({
      tracks: [{ id: 1, codec: 'avc1.video' }, { id: 2, codec: 'mp4a.audio' }],
    }, mixedBuffer);

    expect(video.state.initData?.[0].codecString).toBe('video/mp4; codecs="avc1.video"');
    expect(audio.state.initData?.[0].codecString).toBe('video/mp4; codecs="mp4a.audio"');
    expect(mixed.state.initData?.[0].codecString).toBe('video/mp4; codecs="avc1.video, mp4a.audio"');
  });

  it('preserves numeric-key ordering through the final unified MIME', () => {
    const { state } = runReady({
      tracks: [
        { id: 2, codec: 'avc2' },
        { id: 1, codec: 'mp4a1' },
      ],
    }, new ArrayBuffer(1));

    expect(state.initData?.[0].codecString).toBe('video/mp4; codecs="mp4a1, avc2"');
  });

  it('overwrites duplicate codec IDs but configures every occurrence', () => {
    const { state, mp4file } = runReady({
      tracks: [
        { id: 1, codec: 'avc.first' },
        { id: 1, codec: 'mp4a.last' },
      ],
    }, new ArrayBuffer(1));

    expect(mp4file.setSegmentOptions).toHaveBeenCalledTimes(2);
    expect(state.initData?.[0].codecString).toBe('video/mp4; codecs="mp4a.last"');
  });

  it('preserves empty and missing codec stringification for recognized tracks', () => {
    const { state } = runReady({
      tracks: [
        { id: 1, codec: '' },
        { id: 2 },
      ],
      videoTracks: [{ id: 1 }, { id: 2 }],
    }, new ArrayBuffer(1));

    expect(state.initData?.[0].codecString).toBe('video/mp4; codecs=", undefined"');
  });

  it('executes the ready lifecycle in order and preserves init buffer identity', () => {
    const calls: string[] = [];
    const buffer = new ArrayBuffer(8);
    const resolveReady = jasmine.createSpy('resolveReady').and.callFake(() => calls.push('resolveReady'));
    const state: ReadyState = { videoDuration: null, initData: null, resolveReady };
    const mp4file = jasmine.createSpyObj<ReadyMp4File>('mp4file', [
      'setSegmentOptions',
      'initializeSegmentation',
      'start',
    ]);
    mp4file.setSegmentOptions.and.callFake(() => calls.push('setSegmentOptions'));
    mp4file.initializeSegmentation.and.callFake(() => {
      calls.push('initializeSegmentation');
      return { buffer };
    });
    mp4file.start.and.callFake(() => calls.push('start'));

    handleTransmuxReady({
      duration: 900,
      timescale: 30,
      tracks: [{ id: 1, codec: 'avc1.ready' }],
    }, state, mp4file);

    expect(calls).toEqual(['setSegmentOptions', 'initializeSegmentation', 'start', 'resolveReady']);
    expect(mp4file.initializeSegmentation).toHaveBeenCalledTimes(1);
    expect(mp4file.start).toHaveBeenCalledTimes(1);
    expect(state.videoDuration).toBe(30);
    expect(state.initData?.[0].id).toBe(0);
    expect(state.initData?.[0].buffer).toBe(buffer);
    expect(resolveReady).toHaveBeenCalledTimes(1);
    expect(state.resolveReady).toBeNull();
  });

  it('resets initData, starts without a buffer and safely handles a null resolver', () => {
    const state: ReadyState = {
      videoDuration: null,
      initData: [{ id: 9, codecString: 'stale', buffer: new ArrayBuffer(1) }],
      resolveReady: null,
    };
    const mp4file = jasmine.createSpyObj<ReadyMp4File>('mp4file', [
      'setSegmentOptions',
      'initializeSegmentation',
      'start',
    ]);
    mp4file.initializeSegmentation.and.returnValue({});

    handleTransmuxReady({ tracks: [{ id: 1, codec: 'avc1.no-buffer' }] }, state, mp4file);

    expect(state.initData).toEqual([]);
    expect(mp4file.start).toHaveBeenCalledTimes(1);
  });

  it('configures a seek candidate without starting sample processing', () => {
    const resolveReady = jasmine.createSpy('resolveReady');
    const state: ReadyState = { videoDuration: null, initData: null, resolveReady };
    const mp4file = jasmine.createSpyObj<ReadyMp4File>('mp4file', [
      'setSegmentOptions',
      'initializeSegmentation',
      'start',
    ]);
    const initBuffer = new ArrayBuffer(2);
    mp4file.initializeSegmentation.and.returnValue({ buffer: initBuffer });

    handleTransmuxReady(
      { tracks: [{ id: 1, codec: 'avc1.seek' }] },
      state,
      mp4file,
      false,
    );

    expectOptions(mp4file.setSegmentOptions, 1);
    expect(mp4file.initializeSegmentation).toHaveBeenCalledTimes(1);
    expect(mp4file.start).not.toHaveBeenCalled();
    expect(state.initData?.[0].buffer).toBe(initBuffer);
    expect(resolveReady).toHaveBeenCalledTimes(1);
  });

  it('ignores a late ready callback after the parser entered its terminal state', () => {
    const readyState = {
      videoDuration: null,
      initData: null,
      resolveReady: jasmine.createSpy('resolveReady'),
      terminalError: new Error('MP4_PARSER_ERROR'),
    } as any;
    const mp4file = jasmine.createSpyObj<ReadyMp4File>('mp4file', [
      'setSegmentOptions',
      'initializeSegmentation',
      'start',
    ]);

    handleTransmuxReady({
      duration: 900,
      timescale: 30,
      tracks: [{ id: 1, codec: 'avc1.late' }],
    }, readyState, mp4file);

    expect(readyState.videoDuration).toBeNull();
    expect(readyState.initData).toBeNull();
    expect(readyState.resolveReady).not.toHaveBeenCalled();
    expect(mp4file.setSegmentOptions).not.toHaveBeenCalled();
    expect(mp4file.initializeSegmentation).not.toHaveBeenCalled();
    expect(mp4file.start).not.toHaveBeenCalled();
  });
});
