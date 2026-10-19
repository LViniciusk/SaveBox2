/**
 * stream-transmux.worker.ts
 *
 * Phase 2 / Worker 2: Transmuxing worker (MP4 -> Fragmented MP4).
 *
 * Responsibilities:
 *   - Receives a raw plaintext MP4 chunk from the main thread.
 *   - Uses mp4box.js to parse the MP4 box structure and re-package the
 *     samples into Fragmented MP4 (fMP4) segments that the Media Source
 *     Extensions API can consume incrementally via SourceBuffer.appendBuffer.
 *   - Extracts the codec string (e.g. 'video/mp4; codecs="avc1.42E01E"')
 *     from the first chunk so the main thread can create the SourceBuffer
 *     with the correct MIME type before the first appendBuffer call.
 *   - Transfers all heavy ArrayBuffers back to the caller as Transferables.
 *
 * mp4box.js integration notes:
 *   mp4box.js expects to receive typed FileStart/Buffer notifications and
 *   drives its own internal state machine. This worker wraps that state
 *   machine so the orchestrator can treat it as a simple request/response
 *   pipeline.
 *
 * Message API
 * -----------
 * IN  { type: 'BOOTSTRAP'; chunk0: ArrayBuffer; moovBytes: ArrayBuffer | null;
 *       moovOffset?: number; isLastChunk?: boolean; }
 *     { type: 'SEEK'; time: number; generation: number }
 *     { type: 'TRANSMUX_CHUNK'; decryptedChunk: ArrayBuffer;
 *       chunkIndex: number; isLastChunk: boolean }
 *
 * OUT (success)
 *     { type: 'BOOTSTRAP_COMPLETE'; segments: Array<{ id: number; buffer: ArrayBuffer }>;
 *       initData?: Array<{ id: number; codecString: string; buffer: ArrayBuffer }> }
 *     { type: 'SEEK_COMPLETE'; chunkIndex: number; resumeTime: number;
 *       exactOffset: number; generation: number }
 *     { type: 'CHUNK_TRANSMUXED'; segments: Array<{ id: number; buffer: ArrayBuffer }>;
 *       chunkIndex: number }
 *
 * OUT (error)
 *     { type: 'ERROR'; chunkIndex: number; message: string; }
 *
 * NOTE on mp4box.js:
 *   Install via:  npm install mp4box
 *   Types:        npm install --save-dev @types/mp4box  (community maintained)
 *
 *   The library is loaded via a standard ES module import so Angular's build
 *   system bundles it into the worker chunk automatically.
 */

import * as MP4Box from 'mp4box';
import { createTransmuxMessageHandler } from './stream-transmux-protocol';
import { createTransmuxState } from './stream-transmux-state';

// ---------------------------------------------------------------------------
// MP4Box state is stateful. BOOTSTRAP creates the initial state; each
// unbuffered SEEK builds a fresh candidate and only the latest successful
// generation becomes active. TRANSMUX_CHUNK messages then feed that state in order.
// ---------------------------------------------------------------------------

function createState(startOnReady = true) {
  let mp4file: any;
  try {
    if (typeof (MP4Box as any).createFile === 'function') {
      mp4file = (MP4Box as any).createFile();
    } else {
      throw new Error('MP4Box.createFile is not a function');
    }
  } catch (err: any) {
    console.error('[TransmuxWorker] Failed to create mp4file:', err);
    throw err;
  }

  return createTransmuxState(mp4file, startOnReady);
}

const handleMessage = createTransmuxMessageHandler(
  createState,
  (message, transferables = []) => self.postMessage(message, transferables),
);

self.onmessage = (event: MessageEvent) => {
  void handleMessage(event.data);
};
