import { KASUMI_CHUNK_SIZE } from '../../../core/crypto/kasumi-format';
import { createTransmuxMessageHandler } from './stream-transmux-protocol';
import { createTransmuxState, TRANSMUX_PARSER_ERROR } from './stream-transmux-state';
import type { Mp4ResourceGuard } from './stream-transmux-resource-guard';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface PostedMessage {
  message: Record<string, any>;
  transferables: Transferable[];
}

describe('stream-transmux protocol', () => {
  function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve'];
    let reject!: Deferred<T>['reject'];
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function state(readyPromise: Promise<void> = Promise.resolve(), options: any = {}): any {
    const mp4file = {
      appendBuffer: jasmine.createSpy('appendBuffer'),
      flush: jasmine.createSpy('flush'),
      start: jasmine.createSpy('start'),
      seek: jasmine.createSpy('seek').and.returnValue({ offset: KASUMI_CHUNK_SIZE * 3 + 7, time: 0 }),
    };
    return {
      mp4file,
      initData: options.initData ?? null,
      videoDuration: options.videoDuration ?? 42,
      pendingSegments: options.pendingSegments ?? [],
      terminalError: null,
      readyPromise,
    };
  }

  function reportTerminalError(current: any): void {
    current.terminalError ??= new Error(TRANSMUX_PARSER_ERROR);
    current.pendingSegments.splice(0);
  }

  function realParserState(): { mp4file: jasmine.SpyObj<any>; parserState: ReturnType<typeof createTransmuxState> } {
    const mp4file = jasmine.createSpyObj<any>('mp4file', [
      'appendBuffer',
      'flush',
      'start',
      'seek',
      'setSegmentOptions',
      'initializeSegmentation',
      'releaseUsedSamples',
    ]);
    mp4file.initializeSegmentation.and.returnValue(undefined);
    return { mp4file, parserState: createTransmuxState(mp4file) };
  }

  function harness(states: any[]): {
    handle: (data: any) => Promise<void>;
    posts: PostedMessage[];
    requestedStartModes: boolean[];
  } {
    const posts: PostedMessage[] = [];
    const requestedStartModes: boolean[] = [];
    const handle = createTransmuxMessageHandler(
      (startOnReady = true) => {
        requestedStartModes.push(startOnReady);
        return states.shift();
      },
      (message, transferables = []) => posts.push({ message, transferables }),
      { createResourceGuard: permissiveGuard },
    );
    return { handle, posts, requestedStartModes };
  }

  function permissiveGuard(): Mp4ResourceGuard {
    const usage: Mp4ResourceGuard['usage'] = {
      declaredSamples: 0,
      auxiliaryUnits: 0,
      metadataBytes: 0,
      visitedBoxes: 0,
      estimatedBytes: 0,
      mode: 'unknown',
    };
    return {
      usage,
      inspect: () => ({ decision: 'append', complete: true, pendingBytes: 0, retainedBytes: 0, usage }),
      finish: () => ({ decision: 'append', complete: true, pendingBytes: 0, retainedBytes: 0, usage }),
    };
  }

  async function bootstrap(
    handle: (data: any) => Promise<void>,
    chunk0 = new ArrayBuffer(4),
    moovBytes: ArrayBuffer | null = new ArrayBuffer(3),
  ): Promise<void> {
    await handle({
      type: 'BOOTSTRAP',
      chunk0,
      moovBytes,
      moovOffset: 99,
      isLastChunk: false,
    });
  }

  it('preserves bootstrap parsing, clones, ready wait, draining and transfer ownership', async () => {
    const ready = deferred<void>();
    const initBuffer = new ArrayBuffer(8);
    const segmentBuffer = new ArrayBuffer(5);
    const bootstrapState = state(ready.promise, {
      initData: [{ id: 1, codecString: 'video/mp4; codecs="avc1.test"', buffer: initBuffer }],
      pendingSegments: [{ id: 0, buffer: segmentBuffer }],
      videoDuration: 12,
    });
    const { handle, posts } = harness([bootstrapState]);
    const chunk0 = new ArrayBuffer(4);
    const moovBytes = new ArrayBuffer(3);

    const pending = handle({ type: 'BOOTSTRAP', chunk0, moovBytes, moovOffset: 99, isLastChunk: true });
    expect(posts).toHaveSize(0);
    ready.resolve();
    await pending;

    expect(bootstrapState.mp4file.appendBuffer).toHaveBeenCalledWith(chunk0);
    expect(bootstrapState.mp4file.appendBuffer).toHaveBeenCalledWith(moovBytes);
    expect((chunk0 as any).fileStart).toBe(0);
    expect((moovBytes as any).fileStart).toBe(99);
    expect(bootstrapState.mp4file.flush).toHaveBeenCalledTimes(1);
    expect(posts).toHaveSize(1);
    expect(posts[0].message).toEqual({
      type: 'BOOTSTRAP_COMPLETE',
      videoDuration: 12,
      initData: [{ id: 1, codecString: 'video/mp4; codecs="avc1.test"', buffer: initBuffer }],
      segments: [{ id: 0, buffer: segmentBuffer }],
    });
    expect(posts[0].transferables).toEqual([initBuffer, segmentBuffer]);
    expect(bootstrapState.initData).toBeNull();
    expect(bootstrapState.pendingSegments).toEqual([]);
  });

  it('supports bootstrap without moov and waits for readiness before publishing', async () => {
    const ready = deferred<void>();
    const bootstrapState = state(ready.promise);
    const { handle, posts } = harness([bootstrapState]);
    const pending = handle({ type: 'BOOTSTRAP', chunk0: new ArrayBuffer(2), moovBytes: null });

    expect(bootstrapState.mp4file.appendBuffer).toHaveBeenCalledTimes(1);
    expect(posts).toHaveSize(0);
    ready.resolve();
    await pending;
    expect(posts[0].message).toEqual({ type: 'BOOTSTRAP_COMPLETE', videoDuration: 42, segments: [] });
  });

  it('keeps the bootstrap timeout contract', async () => {
    jasmine.clock().install();
    try {
      const bootstrapState = state(new Promise<void>(() => {}));
      const { handle, posts } = harness([bootstrapState]);
      const pending = handle({ type: 'BOOTSTRAP', chunk0: new ArrayBuffer(1), moovBytes: null });
      jasmine.clock().tick(5000);
      await pending;

      expect(posts).toEqual([
        {
          message: {
            type: 'ERROR',
            chunkIndex: -1,
            message: 'MOOV_NOT_FOUND: mp4box onReady timed out after 5s during bootstrap.',
          },
          transferables: [],
        },
      ]);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('preserves chunk offsets, flush policy and transferables', async () => {
    const bootstrapState = state();
    const { handle, posts } = harness([bootstrapState]);
    await bootstrap(handle);
    posts.length = 0;
    const segmentBuffer = new ArrayBuffer(6);
    bootstrapState.pendingSegments = [{ id: 3, buffer: segmentBuffer }];

    const chunk = new ArrayBuffer(11);
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: chunk, chunkIndex: 4, isLastChunk: true });

    expect(bootstrapState.mp4file.appendBuffer).toHaveBeenCalledWith(chunk);
    expect((chunk as any).fileStart).toBe(4 * KASUMI_CHUNK_SIZE);
    expect(bootstrapState.mp4file.flush).toHaveBeenCalledTimes(1);
    expect(posts[0].message).toEqual({
      type: 'CHUNK_TRANSMUXED',
      segments: [{ id: 3, buffer: segmentBuffer }],
      chunkIndex: 4,
    });
    expect(posts[0].transferables).toEqual([segmentBuffer]);
    expect(bootstrapState.pendingSegments).toEqual([]);
  });

  it('does not report a chunk as successful when MP4Box reports an error after readiness', async () => {
    const bootstrapState = state();
    const { handle, posts } = harness([bootstrapState]);
    await bootstrap(handle);
    posts.length = 0;

    bootstrapState.mp4file.onError = () => {
      reportTerminalError(bootstrapState);
    };
    bootstrapState.mp4file.appendBuffer.and.callFake(() => {
      bootstrapState.mp4file.onError('untrusted parser details');
    });

    await handle({
      type: 'TRANSMUX_CHUNK',
      decryptedChunk: new ArrayBuffer(2),
      chunkIndex: 6,
      isLastChunk: false,
    });

    expect(posts.map(({ message }) => message['type'])).toEqual(['ERROR']);
    expect(posts[0].message['chunkIndex']).toBe(6);
  });

  it('does not publish bootstrap when MP4Box reports an error from appendBuffer', async () => {
    const bootstrapState = state(undefined, {
      pendingSegments: [{ id: 0, buffer: new ArrayBuffer(3) }],
    });
    bootstrapState.mp4file.onError = () => reportTerminalError(bootstrapState);
    bootstrapState.mp4file.appendBuffer.and.callFake(() => {
      bootstrapState.mp4file.onError('untrusted bootstrap parser details');
    });
    const { handle, posts } = harness([bootstrapState]);

    await bootstrap(handle);

    expect(posts.map(({ message }) => message['type'])).toEqual(['ERROR']);
    expect(bootstrapState.pendingSegments).toEqual([]);
  });

  it('does not publish a flushed chunk after MP4Box reports a terminal error', async () => {
    const bootstrapState = state();
    const { handle, posts } = harness([bootstrapState]);
    await bootstrap(handle);
    posts.length = 0;
    bootstrapState.pendingSegments.push({ id: 0, buffer: new ArrayBuffer(3) });
    bootstrapState.mp4file.onError = () => reportTerminalError(bootstrapState);
    bootstrapState.mp4file.flush.and.callFake(() => {
      bootstrapState.mp4file.onError('untrusted flush parser details');
    });

    await handle({
      type: 'TRANSMUX_CHUNK',
      decryptedChunk: new ArrayBuffer(2),
      chunkIndex: 7,
      isLastChunk: true,
    });

    expect(posts.map(({ message }) => message['type'])).toEqual(['ERROR']);
    expect(posts[0].message['message']).toBe('MP4_PARSER_ERROR: Failed to parse media data.');
  });

  it('rejects later messages for a parser instance already in the terminal state', async () => {
    const bootstrapState = state();
    const { handle, posts } = harness([bootstrapState]);
    await bootstrap(handle);
    posts.length = 0;
    bootstrapState.terminalError = new Error('MP4_PARSER_ERROR: Failed to parse media data.');
    bootstrapState.mp4file.appendBuffer.calls.reset();

    await handle({
      type: 'TRANSMUX_CHUNK',
      decryptedChunk: new ArrayBuffer(2),
      chunkIndex: 8,
      isLastChunk: false,
    });

    expect(posts.map(({ message }) => message['type'])).toEqual(['ERROR']);
    expect(bootstrapState.mp4file.appendBuffer).not.toHaveBeenCalled();
  });

  it('isolates a failed seek candidate from the active parser instance', async () => {
    const bootstrapState = state();
    const seekState = state();
    seekState.mp4file.onError = () => reportTerminalError(seekState);
    seekState.mp4file.appendBuffer.and.callFake(() => {
      seekState.mp4file.onError('untrusted seek parser details');
    });
    const { handle, posts } = harness([bootstrapState, seekState]);
    await bootstrap(handle);
    posts.length = 0;

    await handle({ type: 'SEEK', time: 5, generation: 21 });
    await handle({
      type: 'TRANSMUX_CHUNK',
      decryptedChunk: new ArrayBuffer(2),
      chunkIndex: 9,
      isLastChunk: false,
    });

    expect(posts.map(({ message }) => message['type'])).toEqual(['ERROR', 'CHUNK_TRANSMUXED']);
    expect(posts[0].message['generation']).toBe(21);
    expect(bootstrapState.mp4file.appendBuffer).toHaveBeenCalledTimes(3);
    expect(seekState.mp4file.start).not.toHaveBeenCalled();
  });

  it('reports a missing bootstrap and keeps unknown messages as no-ops', async () => {
    const { handle, posts } = harness([]);
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: new ArrayBuffer(1), chunkIndex: 2, isLastChunk: false });
    await handle({ type: 'UNKNOWN' });

    expect(posts).toEqual([
      {
        message: {
          type: 'ERROR',
          chunkIndex: 2,
          message: 'Worker was not bootstrapped. Call BOOTSTRAP first.',
        },
        transferables: [],
      },
    ]);
  });

  it('replays only cloned bootstrap buffers for each seek and preserves seek math', async () => {
    const bootstrapState = state();
    const seekState = state();
    const { handle, posts, requestedStartModes } = harness([bootstrapState, seekState]);
    const chunk0 = new ArrayBuffer(4);
    const moovBytes = new ArrayBuffer(3);
    await bootstrap(handle, chunk0, moovBytes);
    posts.length = 0;

    await handle({ type: 'SEEK', time: 18, generation: 7 });

    const replayedChunk = seekState.mp4file.appendBuffer.calls.argsFor(0)[0];
    const replayedMoov = seekState.mp4file.appendBuffer.calls.argsFor(1)[0];
    expect(replayedChunk).not.toBe(chunk0);
    expect(replayedMoov).not.toBe(moovBytes);
    expect(new Uint8Array(replayedChunk)).toEqual(new Uint8Array(chunk0));
    expect(new Uint8Array(replayedMoov)).toEqual(new Uint8Array(moovBytes));
    expect((replayedChunk as any).fileStart).toBe(0);
    expect((replayedMoov as any).fileStart).toBe(99);
    expect(seekState.mp4file.seek).toHaveBeenCalledWith(18, true);
    expect(seekState.mp4file.start).toHaveBeenCalledTimes(1);
    expect(requestedStartModes).toEqual([true, false]);
    expect(posts).toEqual([
      {
        message: {
          type: 'SEEK_COMPLETE',
          chunkIndex: 3,
          resumeTime: 0,
          exactOffset: KASUMI_CHUNK_SIZE * 3 + 7,
          generation: 7,
        },
        transferables: [],
      },
    ]);
  });

  it('does not publish pre-seek segments with the first target chunk', async () => {
    const bootstrapState = state();
    const ready = deferred<void>();
    const seekState = state(ready.promise, {
      initData: [{ id: 0, codecString: 'video/mp4', buffer: new ArrayBuffer(3) }],
    });
    const { handle, posts } = harness([bootstrapState, seekState]);
    await bootstrap(handle);
    posts.length = 0;

    const pendingSeek = handle({ type: 'SEEK', time: 18, generation: 12 });
    const preSeekSegments = [new ArrayBuffer(5), new ArrayBuffer(6), new ArrayBuffer(7)];
    const targetSegment = new ArrayBuffer(7);
    seekState.mp4file.start.and.callFake(() => {
      seekState.pendingSegments.push({ id: 0, buffer: targetSegment });
    });
    for (const buffer of preSeekSegments) seekState.pendingSegments.push({ id: 0, buffer });

    ready.resolve();
    await pendingSeek;

    expect(seekState.initData).toBeNull();
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: new ArrayBuffer(2), chunkIndex: 4, isLastChunk: false });

    const chunkMessage = posts.find(({ message }) => message['type'] === 'CHUNK_TRANSMUXED');
    expect(chunkMessage?.message['segments']).toEqual([{ id: 0, buffer: targetSegment }]);
    expect(chunkMessage?.message['segments'][0].buffer).toBe(targetSegment);
    expect(chunkMessage?.transferables).toEqual([targetSegment]);
  });

  it('isolates overlapping seeks when generation one resolves first', async () => {
    const bootstrapState = state();
    const readyA = deferred<void>();
    const readyB = deferred<void>();
    const seekA = state(readyA.promise);
    const seekB = state(readyB.promise);
    seekA.mp4file.seek.and.returnValue({ offset: KASUMI_CHUNK_SIZE, time: 10 });
    seekB.mp4file.seek.and.returnValue({ offset: KASUMI_CHUNK_SIZE * 2, time: 20 });
    const { handle, posts } = harness([bootstrapState, seekA, seekB]);
    await bootstrap(handle);
    posts.length = 0;

    const first = handle({ type: 'SEEK', time: 10, generation: 1 });
    const second = handle({ type: 'SEEK', time: 20, generation: 2 });
    readyA.resolve();
    await first;
    expect(seekA.mp4file.seek).not.toHaveBeenCalled();
    expect(seekA.mp4file.start).not.toHaveBeenCalled();
    expect(seekB.mp4file.seek).not.toHaveBeenCalled();
    readyB.resolve();
    await second;

    expect(seekB.mp4file.seek).toHaveBeenCalledWith(20, true);
    expect(seekB.mp4file.start).toHaveBeenCalledTimes(1);
    expect(posts.map(({ message }) => message)).toEqual([
      { type: 'SEEK_COMPLETE', chunkIndex: 2, resumeTime: 20, exactOffset: KASUMI_CHUNK_SIZE * 2, generation: 2 },
    ]);
  });

  it('keeps the newest seek state active when generation two resolves first', async () => {
    const bootstrapState = state();
    const readyA = deferred<void>();
    const readyB = deferred<void>();
    const seekA = state(readyA.promise);
    const seekB = state(readyB.promise);
    const { handle, posts } = harness([bootstrapState, seekA, seekB]);
    await bootstrap(handle);
    posts.length = 0;

    const first = handle({ type: 'SEEK', time: 10, generation: 1 });
    const second = handle({ type: 'SEEK', time: 20, generation: 2 });
    readyB.resolve();
    await second;
    readyA.resolve();
    await first;

    const chunk = new ArrayBuffer(2);
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: chunk, chunkIndex: 8, isLastChunk: false });
    expect(seekB.mp4file.appendBuffer).toHaveBeenCalledWith(chunk);
    expect(seekA.mp4file.appendBuffer).not.toHaveBeenCalledWith(chunk);
    expect(seekB.mp4file.start).toHaveBeenCalledTimes(1);
    expect(posts.filter(({ message }) => message['type'] === 'SEEK_COMPLETE')).toHaveSize(1);
  });

  it('terminates seek failures with one generation-correlated error', async () => {
    const bootstrapState = state();
    const appendFailure = state();
    appendFailure.mp4file.appendBuffer.and.callFake(() => {
      throw { message: 'append failed' };
    });
    const { handle, posts } = harness([bootstrapState, appendFailure]);
    await bootstrap(handle);
    posts.length = 0;

    await handle({ type: 'SEEK', time: 5, generation: 11 });

    expect(posts).toEqual([
      {
        message: { type: 'ERROR', chunkIndex: -1, message: TRANSMUX_PARSER_ERROR, generation: 11 },
        transferables: [],
      },
    ]);
  });

  it('terminates seek readiness and seek-operation failures', async () => {
    const bootstrapState = state();
    const readyFailure = state(Promise.reject(new Error('ready failed')));
    const seekFailure = state();
    seekFailure.mp4file.seek.and.callFake(() => {
      throw new Error('seek failed');
    });
    const { handle, posts } = harness([bootstrapState, readyFailure, seekFailure]);
    await bootstrap(handle);
    posts.length = 0;

    await handle({ type: 'SEEK', time: 5, generation: 12 });
    await handle({ type: 'SEEK', time: 6, generation: 13 });

    expect(posts.map(({ message }) => message)).toEqual([
      { type: 'ERROR', chunkIndex: -1, message: TRANSMUX_PARSER_ERROR, generation: 12 },
      { type: 'ERROR', chunkIndex: -1, message: TRANSMUX_PARSER_ERROR, generation: 13 },
    ]);
  });

  it('does not commit an active state when the winning candidate start fails', async () => {
    const bootstrapState = state();
    const failedCandidate = state();
    failedCandidate.mp4file.start.and.callFake(() => {
      throw new Error('start failed');
    });
    const { handle, posts } = harness([bootstrapState, failedCandidate]);
    await bootstrap(handle);
    posts.length = 0;

    await handle({ type: 'SEEK', time: 5, generation: 14 });

    expect(posts).toEqual([
      {
        message: { type: 'ERROR', chunkIndex: -1, message: TRANSMUX_PARSER_ERROR, generation: 14 },
        transferables: [],
      },
    ]);
    const chunk = new ArrayBuffer(2);
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: chunk, chunkIndex: 2, isLastChunk: false });
    expect(bootstrapState.mp4file.appendBuffer).toHaveBeenCalledWith(chunk);
    expect(failedCandidate.mp4file.appendBuffer).not.toHaveBeenCalledWith(chunk);
  });

  it('uses the parser callback as terminal authority and never exposes its source message', async () => {
    const { mp4file, parserState } = realParserState();
    mp4file.onReady({ tracks: [] });
    const posts: PostedMessage[] = [];
    const handle = createTransmuxMessageHandler(
      () => parserState,
      (message, transferables = []) => posts.push({ message, transferables }),
      { createResourceGuard: permissiveGuard },
    );
    await bootstrap(handle);
    posts.length = 0;
    mp4file.appendBuffer.and.callFake(() => mp4file.onError('private filename, bytes and URL'));

    await handle({
      type: 'TRANSMUX_CHUNK',
      decryptedChunk: new ArrayBuffer(2),
      chunkIndex: 10,
      isLastChunk: false,
    });

    expect(posts).toEqual([{
      message: { type: 'ERROR', chunkIndex: 10, message: TRANSMUX_PARSER_ERROR },
      transferables: [],
    }]);
    expect(parserState.terminalError?.message).toBe(TRANSMUX_PARSER_ERROR);

    const callsAfterFailure = mp4file.appendBuffer.calls.count();
    posts.length = 0;
    await handle({
      type: 'TRANSMUX_CHUNK',
      decryptedChunk: new ArrayBuffer(2),
      chunkIndex: 11,
      isLastChunk: false,
    });
    expect(posts).toEqual([{
      message: { type: 'ERROR', chunkIndex: 11, message: TRANSMUX_PARSER_ERROR },
      transferables: [],
    }]);
    expect(mp4file.appendBuffer.calls.count()).toBe(callsAfterFailure);
    await expectAsync(parserState.readyPromise).toBeResolved();
  });

  it('rejects bootstrap and discards segments when the parser callback fails before readiness', async () => {
    const { mp4file, parserState } = realParserState();
    const posts: PostedMessage[] = [];
    const handle = createTransmuxMessageHandler(
      () => parserState,
      (message, transferables = []) => posts.push({ message, transferables }),
      { createResourceGuard: permissiveGuard },
    );
    parserState.pendingSegments.push({ id: 0, buffer: new ArrayBuffer(3) });
    mp4file.appendBuffer.and.callFake(() => mp4file.onError('private malformed-box information'));

    await bootstrap(handle);

    expect(posts.map(({ message }) => message['type'])).toEqual(['ERROR']);
    expect(posts[0].message['message']).toBe(TRANSMUX_PARSER_ERROR);
    expect(parserState.pendingSegments).toEqual([]);
    await expectAsync(parserState.readyPromise).toBeRejectedWithError(TRANSMUX_PARSER_ERROR);
  });

  it('rejects a flush callback failure without publishing queued segments', async () => {
    const { mp4file, parserState } = realParserState();
    mp4file.onReady({ tracks: [] });
    const posts: PostedMessage[] = [];
    const handle = createTransmuxMessageHandler(
      () => parserState,
      (message, transferables = []) => posts.push({ message, transferables }),
      { createResourceGuard: permissiveGuard },
    );
    await bootstrap(handle);
    posts.length = 0;
    mp4file.onSegment(1, null, new ArrayBuffer(5), 35, false);
    mp4file.flush.and.callFake(() => mp4file.onError('private flush failure'));

    await handle({
      type: 'TRANSMUX_CHUNK',
      decryptedChunk: new ArrayBuffer(2),
      chunkIndex: 12,
      isLastChunk: true,
    });

    expect(posts).toEqual([{
      message: { type: 'ERROR', chunkIndex: 12, message: TRANSMUX_PARSER_ERROR },
      transferables: [],
    }]);
    expect(parserState.pendingSegments).toEqual([]);
  });

  it('observes readiness rejection when callback failure and synchronous append throw coincide', async () => {
    const { mp4file, parserState } = realParserState();
    const posts: PostedMessage[] = [];
    const handle = createTransmuxMessageHandler(
      () => parserState,
      (message, transferables = []) => posts.push({ message, transferables }),
      { createResourceGuard: permissiveGuard },
    );
    mp4file.appendBuffer.and.callFake(() => {
      mp4file.onError('private asynchronous parser detail');
      throw new Error('private synchronous parser detail');
    });

    await handle({ type: 'BOOTSTRAP', chunk0: new ArrayBuffer(1), moovBytes: null });

    expect(posts[0].message).toEqual({
      type: 'ERROR',
      chunkIndex: -1,
      message: TRANSMUX_PARSER_ERROR,
    });
    await expectAsync(parserState.readyPromise).toBeRejectedWithError(TRANSMUX_PARSER_ERROR);
  });
});
