import { KASUMI_CHUNK_SIZE } from '../../../core/crypto/kasumi-format';
import {
  createMp4ResourceGuard,
  MP4_RESOURCE_GUARD_DEFAULTS,
  type Mp4ResourceFailure,
  type Mp4ResourceGuard,
} from './stream-transmux-resource-guard';
import {
  failTransmuxState,
  TRANSMUX_PARSER_ERROR,
  TRANSMUX_RESOURCE_ERROR,
  TRANSMUX_STRUCTURE_ERROR,
  type TransmuxState,
} from './stream-transmux-state';

interface BootstrapData {
  chunk0: ArrayBuffer;
  moovBytes: ArrayBuffer | null;
  moovOffset?: number;
  isLastChunk: boolean;
}

type PostMessage = (message: Record<string, unknown>, transferables?: Transferable[]) => void;
type ResourceGuardFactory = () => Mp4ResourceGuard;

export interface TransmuxProtocolOptions {
  createResourceGuard?: ResourceGuardFactory;
  aggregateBudgetBytes?: number;
}

const WORKER_NOT_BOOTSTRAPPED_ERROR = 'Worker was not bootstrapped. Call BOOTSTRAP first.';
const MOOV_NOT_FOUND_ERROR = 'MOOV_NOT_FOUND: mp4box onReady timed out after 5s during bootstrap.';
const STANDALONE_MOOV_TYPE = 0x6d6f6f76;
const MAX_AGGREGATE_SEEK_REPLAY_BYTES = 32 * 1024 * 1024;
const MAX_AGGREGATE_RETAINED_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_BOOTSTRAP_MOOV_BYTES = 8 * 1024 * 1024;

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (
    message === WORKER_NOT_BOOTSTRAPPED_ERROR ||
    message === MOOV_NOT_FOUND_ERROR ||
    message === TRANSMUX_PARSER_ERROR ||
    message === TRANSMUX_RESOURCE_ERROR ||
    message === TRANSMUX_STRUCTURE_ERROR
  ) {
    return message;
  }
  return TRANSMUX_PARSER_ERROR;
}

function assertParserHealthy(state: TransmuxState): void {
  if (state.terminalError) throw state.terminalError;
}

function runParserOperation<T>(state: TransmuxState, operation: () => T): T {
  try {
    assertParserHealthy(state);
    const result = operation();
    assertParserHealthy(state);
    return result;
  } catch {
    throw failTransmuxState(state);
  }
}

function isStandaloneMoov(input: ArrayBuffer): boolean {
  if (input.byteLength < 8) return false;
  const view = new DataView(input);
  if (view.getUint32(4) !== STANDALONE_MOOV_TYPE) return false;
  const shortSize = view.getUint32(0);
  if (shortSize === 1) {
    return input.byteLength >= 16 && view.getBigUint64(8) === BigInt(input.byteLength);
  }
  return shortSize === input.byteLength || shortSize === 0;
}

function resourceErrorFor(reason: Mp4ResourceFailure | undefined): string {
  return reason === 'resource-limit' ? TRANSMUX_RESOURCE_ERROR : TRANSMUX_STRUCTURE_ERROR;
}

export function createTransmuxMessageHandler(
  createState: (startOnReady?: boolean) => TransmuxState,
  postMessage: PostMessage,
  options: TransmuxProtocolOptions = {},
): (data: any) => Promise<void> {
  let state: TransmuxState | null = null;
  let bootstrapData: BootstrapData | null = null;
  let latestSeekGeneration: number | null = null;
  const createGuard = options.createResourceGuard ?? createMp4ResourceGuard;
  const aggregateBudgetBytes = options.aggregateBudgetBytes ?? MP4_RESOURCE_GUARD_DEFAULTS.aggregateBudgetBytes;
  const guards = new WeakMap<TransmuxState, Mp4ResourceGuard>();
  const liveParsers = new Set<TransmuxState>();
  const retainedMetadataBytes = new Map<TransmuxState, number>();
  const seekReplayBytes = new Map<TransmuxState, number>();

  function guardFor(parserState: TransmuxState): Mp4ResourceGuard {
    let guard = guards.get(parserState);
    if (!guard) {
      guard = createGuard();
      guards.set(parserState, guard);
      liveParsers.add(parserState);
      retainedMetadataBytes.set(parserState, 0);
    }
    return guard;
  }

  function releaseParser(parserState: TransmuxState): void {
    liveParsers.delete(parserState);
    retainedMetadataBytes.delete(parserState);
    seekReplayBytes.delete(parserState);
  }

  function checkAggregate(parserState: TransmuxState): void {
    let total = 0;
    let retained = 0;
    for (const liveParser of liveParsers) {
      const estimate = guards.get(liveParser)?.usage.estimatedBytes ?? 0;
      total += estimate;
      retained += retainedMetadataBytes.get(liveParser) ?? 0;
      if (!Number.isSafeInteger(total)) {
        throw failTransmuxState(parserState, TRANSMUX_RESOURCE_ERROR);
      }
    }
    if (total > aggregateBudgetBytes) throw failTransmuxState(parserState, TRANSMUX_RESOURCE_ERROR);
    if (!Number.isSafeInteger(retained) || retained > MAX_AGGREGATE_RETAINED_METADATA_BYTES) {
      throw failTransmuxState(parserState, TRANSMUX_RESOURCE_ERROR);
    }
  }

  function reserveSeekReplay(parserState: TransmuxState, bytes: number): void {
    let reserved = bytes;
    for (const [owner, existing] of seekReplayBytes) {
      if (owner !== parserState) reserved += existing;
      if (!Number.isSafeInteger(reserved)) throw failTransmuxState(parserState, TRANSMUX_RESOURCE_ERROR);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || reserved > MAX_AGGREGATE_SEEK_REPLAY_BYTES) {
      throw failTransmuxState(parserState, TRANSMUX_RESOURCE_ERROR);
    }
    seekReplayBytes.set(parserState, bytes);
  }

  function inspectBeforeAppend(
    parserState: TransmuxState,
    input: ArrayBuffer,
    absoluteOffset: number,
    inspectOptions: Parameters<Mp4ResourceGuard['inspect']>[2] = {},
  ): void {
    const guard = guardFor(parserState);
    const result = guard.inspect(input, absoluteOffset, inspectOptions);
    retainedMetadataBytes.set(parserState, result.retainedBytes);
    if (result.decision === 'reject') throw failTransmuxState(parserState, resourceErrorFor(result.reason));
    checkAggregate(parserState);
  }

  function finishBeforeFlush(parserState: TransmuxState): void {
    const result = guardFor(parserState).finish();
    retainedMetadataBytes.set(parserState, result.retainedBytes);
    if (result.decision === 'reject') throw failTransmuxState(parserState, resourceErrorFor(result.reason));
    checkAggregate(parserState);
  }

  function inspectBootstrapSupplement(
    parserState: TransmuxState,
    input: ArrayBuffer,
    absoluteOffset: number,
    isLastChunk: boolean,
  ): void {
    inspectBeforeAppend(
      parserState,
      input,
      absoluteOffset,
      isStandaloneMoov(input)
        ? { supplemental: true }
        : { final: isLastChunk },
    );
  }

  function postError(data: any, err: any, generation?: number): void {
    const message: Record<string, unknown> = {
      type: 'ERROR',
      chunkIndex: data.chunkIndex ?? -1,
      message: publicErrorMessage(err),
    };
    if (generation !== undefined) message['generation'] = generation;
    postMessage(message);
  }

  async function handleSeek(data: any): Promise<void> {
    const { time, generation } = data;
    latestSeekGeneration = generation;
    let seekState: TransmuxState | null = null;
    let promoted = false;
    const previousState = state;

    try {
      if (previousState) assertParserHealthy(previousState);
      if (!bootstrapData) throw new Error(WORKER_NOT_BOOTSTRAPPED_ERROR);

      seekState = createState(false);
      guardFor(seekState);
      const { chunk0, moovBytes, moovOffset } = bootstrapData;
      reserveSeekReplay(seekState, chunk0.byteLength + (moovBytes?.byteLength ?? 0));

      const newChunk0 = chunk0.slice(0);
      (newChunk0 as any).fileStart = 0;
      inspectBeforeAppend(seekState, newChunk0, 0, {
        final: bootstrapData.isLastChunk && !moovBytes,
      });
      runParserOperation(seekState, () => seekState!.mp4file.appendBuffer(newChunk0));

      if (moovBytes && typeof moovOffset === 'number') {
        const newMoov = moovBytes.slice(0);
        (newMoov as any).fileStart = moovOffset;
        inspectBootstrapSupplement(seekState, newMoov, moovOffset, bootstrapData.isLastChunk);
        runParserOperation(seekState, () => seekState!.mp4file.appendBuffer(newMoov));
      }

      try {
        await seekState.readyPromise;
      } catch {
        throw failTransmuxState(seekState);
      }
      assertParserHealthy(seekState);
      if (generation !== latestSeekGeneration) return;

      seekState.initData = null;
      seekState.pendingSegments.splice(0);
      const seekResult = runParserOperation(seekState, () => seekState!.mp4file.seek(time, true));
      if (generation !== latestSeekGeneration) return;
      runParserOperation(seekState, () => seekState!.mp4file.start());
      state = seekState;
      promoted = true;
      if (previousState && previousState !== seekState) releaseParser(previousState);

      assertParserHealthy(seekState);
      postMessage({
        type: 'SEEK_COMPLETE',
        chunkIndex: Math.floor(seekResult.offset / KASUMI_CHUNK_SIZE),
        resumeTime: seekResult.time,
        exactOffset: seekResult.offset,
        generation,
      });
    } catch (err: any) {
      postError(data, seekState ? failTransmuxState(seekState) : state?.terminalError ?? err, generation);
    } finally {
      if (seekState && !promoted) {
        if (!seekState.terminalError) failTransmuxState(seekState);
        releaseParser(seekState);
      }
    }
  }

  async function handleBootstrap(data: any): Promise<void> {
    const { chunk0, moovBytes, moovOffset, isLastChunk } = data as {
      chunk0: ArrayBuffer;
      moovBytes: ArrayBuffer | null;
      moovOffset?: number;
      isLastChunk?: boolean;
    };

    let bootstrapState: TransmuxState | null = null;
    try {
      bootstrapState = createState();
      guardFor(bootstrapState);
      state = bootstrapState;

      if (chunk0.byteLength > KASUMI_CHUNK_SIZE || (moovBytes && moovBytes.byteLength > MAX_BOOTSTRAP_MOOV_BYTES)) {
        throw failTransmuxState(bootstrapState, TRANSMUX_RESOURCE_ERROR);
      }

      (chunk0 as any).fileStart = 0;
      inspectBeforeAppend(bootstrapState, chunk0, 0, { final: !!isLastChunk && !moovBytes });
      runParserOperation(bootstrapState, () => bootstrapState!.mp4file.appendBuffer(chunk0));

      if (moovBytes && typeof moovOffset === 'number') {
        (moovBytes as any).fileStart = moovOffset;
        inspectBootstrapSupplement(bootstrapState, moovBytes, moovOffset, !!isLastChunk);
        runParserOperation(bootstrapState, () => bootstrapState!.mp4file.appendBuffer(moovBytes));
      }

      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(MOOV_NOT_FOUND_ERROR)), 5000),
      );
      try {
        await Promise.race([bootstrapState.readyPromise, timeout]);
      } catch (error) {
        if (bootstrapState.terminalError) throw bootstrapState.terminalError;
        throw error;
      }
      assertParserHealthy(bootstrapState);

      if (isLastChunk) {
        finishBeforeFlush(bootstrapState);
        runParserOperation(bootstrapState, () => bootstrapState!.mp4file.flush());
      }
      assertParserHealthy(bootstrapState);

      bootstrapData = {
        chunk0: chunk0.slice(0),
        moovBytes: moovBytes ? moovBytes.slice(0) : null,
        moovOffset,
        isLastChunk: !!isLastChunk,
      };
      const outMessage: Record<string, unknown> = {
        type: 'BOOTSTRAP_COMPLETE',
        videoDuration: bootstrapState.videoDuration,
      };
      const transferables: Transferable[] = [];
      if (bootstrapState.initData) {
        outMessage['initData'] = bootstrapState.initData;
        for (const item of bootstrapState.initData) transferables.push(item.buffer);
        bootstrapState.initData = null;
      }

      const segments = bootstrapState.pendingSegments.splice(0);
      outMessage['segments'] = segments;
      for (const segment of segments) transferables.push(segment.buffer);

      postMessage(outMessage, transferables);
    } catch (error) {
      if (bootstrapState) {
        failTransmuxState(bootstrapState);
        if (state === bootstrapState) state = null;
        releaseParser(bootstrapState);
      }
      bootstrapData = null;
      throw error;
    }
  }

  async function handleTransmuxChunk(data: any): Promise<void> {
    const { decryptedChunk, chunkIndex, isLastChunk } = data as {
      decryptedChunk: ArrayBuffer;
      chunkIndex: number;
      isLastChunk: boolean;
    };

    const activeState = state;
    if (!activeState) throw new Error(WORKER_NOT_BOOTSTRAPPED_ERROR);

    const absoluteOffset = chunkIndex * KASUMI_CHUNK_SIZE;
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Number.isSafeInteger(absoluteOffset)) {
      throw failTransmuxState(activeState, TRANSMUX_STRUCTURE_ERROR);
    }
    (decryptedChunk as any).fileStart = absoluteOffset;
    inspectBeforeAppend(activeState, decryptedChunk, absoluteOffset, { final: !!isLastChunk });
    runParserOperation(activeState, () => activeState.mp4file.appendBuffer(decryptedChunk));
    if (isLastChunk) {
      finishBeforeFlush(activeState);
      runParserOperation(activeState, () => activeState.mp4file.flush());
    }
    assertParserHealthy(activeState);

    const segments = activeState.pendingSegments.splice(0);
    const transferables: Transferable[] = segments.map((segment) => segment.buffer);
    postMessage({ type: 'CHUNK_TRANSMUXED', segments, chunkIndex }, transferables);
  }

  return async (data: any): Promise<void> => {
    if (data.type === 'SEEK') return handleSeek(data);

    try {
      if (data.type === 'BOOTSTRAP') {
        await handleBootstrap(data);
        return;
      }
      if (data.type === 'TRANSMUX_CHUNK') await handleTransmuxChunk(data);
    } catch (err: any) {
      postError(data, err);
    }
  };
}
