import { handleTransmuxReady } from './stream-transmux-ready';
import { handleTransmuxSegment } from './stream-transmux-segment';

export const TRANSMUX_PARSER_ERROR = 'MP4_PARSER_ERROR: Failed to parse media data.';
export const TRANSMUX_RESOURCE_ERROR = 'MP4_RESOURCE_LIMIT: Media metadata exceeds the supported parser budget.';
export const TRANSMUX_STRUCTURE_ERROR = 'MP4_INVALID_STRUCTURE: Invalid or unsupported media structure.';

export interface TransmuxState {
  mp4file: any;
  initData: { id: number; codecString: string; buffer: ArrayBuffer }[] | null;
  videoDuration: number | null;
  pendingSegments: { id: number; buffer: ArrayBuffer }[];
  resolveReady: (() => void) | null;
  rejectReady: ((error: Error) => void) | null;
  readyPromise: Promise<void>;
  terminalError: Error | null;
}

export function failTransmuxState(state: TransmuxState, terminalMessage = TRANSMUX_PARSER_ERROR): Error {
  if (!state.terminalError) {
    state.terminalError = new Error(terminalMessage);
    state.pendingSegments.length = 0;
    state.rejectReady?.(state.terminalError);
  }

  return state.terminalError;
}

export function createTransmuxState(mp4file: any, startOnReady = true): TransmuxState {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void readyPromise.catch(() => undefined);

  const state: TransmuxState = {
    mp4file,
    initData: null,
    videoDuration: null,
    pendingSegments: [],
    resolveReady: null,
    rejectReady: null,
    readyPromise,
    terminalError: null,
  };

  state.resolveReady = () => {
    if (state.terminalError) return;
    state.resolveReady = null;
    state.rejectReady = null;
    resolvePromise();
  };
  state.rejectReady = (error) => {
    if (!state.rejectReady) return;
    state.resolveReady = null;
    state.rejectReady = null;
    rejectPromise(error);
  };

  mp4file.onError = () => failTransmuxState(state);
  mp4file.onReady = (info: unknown) => {
    if (state.terminalError) return;
    try {
      handleTransmuxReady(info as Parameters<typeof handleTransmuxReady>[0], state, mp4file, startOnReady);
    } catch {
      failTransmuxState(state);
    }
  };
  mp4file.onSegment = (
    id: number,
    _user: unknown,
    buffer: ArrayBuffer,
    sampleNumber: number,
    _last: boolean,
  ) => {
    if (state.terminalError) return;
    try {
      handleTransmuxSegment(state, mp4file, id, buffer, sampleNumber);
    } catch {
      failTransmuxState(state);
    }
  };

  return state;
}
