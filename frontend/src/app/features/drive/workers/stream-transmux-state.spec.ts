import { createTransmuxState, TRANSMUX_PARSER_ERROR } from './stream-transmux-state';

describe('stream-transmux parser state', () => {
  function parser(): jasmine.SpyObj<any> {
    const mp4file = jasmine.createSpyObj('mp4file', [
      'appendBuffer',
      'flush',
      'start',
      'seek',
      'setSegmentOptions',
      'initializeSegmentation',
      'releaseUsedSamples',
    ]);
    mp4file.initializeSegmentation.and.returnValue({ buffer: new ArrayBuffer(1) });
    mp4file.seek.and.returnValue({ offset: 0, time: 0 });
    return mp4file;
  }

  it('settles readiness once and removes both settlement callbacks after success', async () => {
    const mp4file = parser();
    const state = createTransmuxState(mp4file);

    mp4file.onReady({ tracks: [] });
    await expectAsync(state.readyPromise).toBeResolved();
    expect(state.resolveReady).toBeNull();
    expect(state.rejectReady).toBeNull();

    mp4file.onError('private media parser details');
    expect(state.terminalError?.message).toBe(TRANSMUX_PARSER_ERROR);
    await expectAsync(state.readyPromise).toBeResolved();
  });

  it('keeps the first sanitized terminal error and rejects pending readiness', async () => {
    const mp4file = parser();
    const state = createTransmuxState(mp4file);
    const readyPromise = state.readyPromise;
    const pendingSegment = { id: 0, buffer: new ArrayBuffer(2) };
    state.pendingSegments.push(pendingSegment);

    mp4file.onError('secret filename, payload and provider URL');
    const firstError = state.terminalError;
    mp4file.onError('a different parser error containing private bytes');

    expect(firstError?.message).toBe(TRANSMUX_PARSER_ERROR);
    expect(state.terminalError).toBe(firstError);
    expect(state.pendingSegments).toEqual([]);
    expect(state.resolveReady).toBeNull();
    expect(state.rejectReady).toBeNull();
    await expectAsync(readyPromise).toBeRejectedWithError(TRANSMUX_PARSER_ERROR);
  });

  it('ignores late parser callbacks after terminal failure', async () => {
    const mp4file = parser();
    const state = createTransmuxState(mp4file);
    mp4file.onError('parser failed');

    mp4file.onReady({
      duration: 900,
      timescale: 30,
      tracks: [{ id: 1, codec: 'avc1.late' }],
    });
    mp4file.onSegment(1, null, new ArrayBuffer(4), 35, false);

    expect(state.initData).toBeNull();
    expect(state.pendingSegments).toEqual([]);
    expect(mp4file.setSegmentOptions).not.toHaveBeenCalled();
    expect(mp4file.initializeSegmentation).not.toHaveBeenCalled();
    expect(mp4file.start).not.toHaveBeenCalled();
    expect(mp4file.releaseUsedSamples).not.toHaveBeenCalled();
    await expectAsync(state.readyPromise).toBeRejectedWithError(TRANSMUX_PARSER_ERROR);
  });
});
