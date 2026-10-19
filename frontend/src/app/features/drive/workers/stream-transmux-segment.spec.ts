import { handleTransmuxSegment } from './stream-transmux-segment';

describe('stream-transmux segment lifecycle', () => {
  function state(): { pendingSegments: Array<{ id: number; buffer: ArrayBuffer }> } {
    return { pendingSegments: [] };
  }

  function releaser(): jasmine.SpyObj<{ releaseUsedSamples(trackId: number, sampleNumber: number): void }> {
    return jasmine.createSpyObj('mp4file', ['releaseUsedSamples']);
  }

  it('copies and queues the segment before releasing the exact source samples', () => {
    const output = new Uint8Array([1, 2, 3, 4]).buffer;
    const current = state();
    const mp4file = releaser();

    mp4file.releaseUsedSamples.and.callFake(() => {
      expect(current.pendingSegments.length).toBe(1);
      expect(current.pendingSegments[0].id).toBe(0);
      expect(current.pendingSegments[0].buffer).not.toBe(output);
    });

    handleTransmuxSegment(current, mp4file, 42, output, 35);

    expect(new Uint8Array(current.pendingSegments[0].buffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(mp4file.releaseUsedSamples).toHaveBeenCalledOnceWith(42, 35);
  });

  it('passes every callback sample number without local arithmetic or deduplication', () => {
    const current = state();
    const mp4file = releaser();

    handleTransmuxSegment(current, mp4file, 7, new ArrayBuffer(1), 35);
    handleTransmuxSegment(current, mp4file, 7, new ArrayBuffer(1), 70);
    handleTransmuxSegment(current, mp4file, 7, new ArrayBuffer(1), 105);

    expect(mp4file.releaseUsedSamples.calls.allArgs()).toEqual([
      [7, 35],
      [7, 70],
      [7, 105],
    ]);
  });

  it('releases each source track while keeping the combined output id at zero', () => {
    const current = state();
    const mp4file = releaser();

    handleTransmuxSegment(current, mp4file, 4, new ArrayBuffer(1), 70);
    handleTransmuxSegment(current, mp4file, 9, new ArrayBuffer(1), 112);

    expect(current.pendingSegments.map((segment) => segment.id)).toEqual([0, 0]);
    expect(mp4file.releaseUsedSamples.calls.allArgs()).toEqual([
      [4, 70],
      [9, 112],
    ]);
  });

  it('propagates release errors after the copied output has been queued', () => {
    const current = state();
    const mp4file = releaser();
    mp4file.releaseUsedSamples.and.throwError('release failed');

    expect(() => handleTransmuxSegment(current, mp4file, 7, new ArrayBuffer(1), 35))
      .toThrowError('release failed');
    expect(current.pendingSegments.length).toBe(1);
  });

  it('ignores late segment callbacks after the parser entered its terminal state', () => {
    const current = { ...state(), terminalError: new Error('MP4_PARSER_ERROR') } as any;
    const mp4file = releaser();

    handleTransmuxSegment(current, mp4file, 7, new ArrayBuffer(1), 35);

    expect(current.pendingSegments).toEqual([]);
    expect(mp4file.releaseUsedSamples).not.toHaveBeenCalled();
  });
});
