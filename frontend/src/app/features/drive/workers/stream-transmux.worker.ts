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
 * IN  { type: 'TRANSMUX_CHUNK'; decryptedChunk: ArrayBuffer;
 *       chunkIndex: number; isFirstChunk: boolean; isLastChunk: boolean; }
 *
 * OUT (success, first chunk also carries codec)
 *     { type: 'CHUNK_TRANSMUXED'; fmp4Chunk: ArrayBuffer; chunkIndex: number;
 *       codecString?: string;  // only present when isFirstChunk === true
 *       initSegment?: ArrayBuffer; }  // only present when isFirstChunk === true
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

const originalLog = console.log;
const originalError = console.error;
console.log = (...args: any[]) => {
  originalLog.apply(console, args);
  try {
    self.postMessage({ type: 'LOG', message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
  } catch (e) {}
};
console.error = (...args: any[]) => {
  originalError.apply(console, args);
  try {
    self.postMessage({ type: 'LOG', message: '[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
  } catch (e) {}
};

// ---------------------------------------------------------------------------
// Per-worker state: mp4box is stateful and accumulates boxes across chunks.
// We create one mp4box.ISOFile instance per worker lifetime and feed all
// chunks through it sequentially. The orchestrator must therefore send chunks
// to the SAME worker instance in order (which VideoStreamService guarantees).
// ---------------------------------------------------------------------------

interface TransmuxState {
  mp4file: any;
  fileOffset: number;
  initData: { id: number; codecString: string; buffer: ArrayBuffer }[] | null;
  videoDuration: number | null;
  pendingSegments: { id: number; buffer: ArrayBuffer }[];
  resolveReady: (() => void) | null;
  rejectReady?: ((err: Error) => void) | null;
  readyPromise: Promise<void>;
}

let state: TransmuxState | null = null;

function createState(): TransmuxState {
  console.log('[TransmuxWorker] MP4Box imported object:', MP4Box);
  let mp4file: any;
  try {
    if (typeof (MP4Box as any).createFile === 'function') {
      mp4file = (MP4Box as any).createFile();
    } else if (MP4Box && typeof (MP4Box as any)['default']?.createFile === 'function') {
      mp4file = (MP4Box as any)['default'].createFile();
    } else {
      throw new Error('MP4Box.createFile is not a function');
    }
  } catch (err: any) {
    console.error('[TransmuxWorker] Failed to create mp4file:', err);
    throw err;
  }

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady  = rej;
  });

  const s: TransmuxState = {
    mp4file,
    fileOffset: 0,
    initData: null,
    videoDuration: null,
    pendingSegments: [],
    resolveReady,
    rejectReady,
    readyPromise,
  };

  mp4file.onError = (err: any) => {
    console.error('[TransmuxWorker] mp4file.onError:', err);
    if (s.rejectReady) {
      s.rejectReady(new Error(err));
      s.rejectReady = null;
      s.resolveReady = null;
    }
  };

  // Called once when mp4box has parsed enough boxes to know the track list.
  mp4file.onReady = (info: any) => {
    if (info.duration && info.timescale) {
      s.videoDuration = info.duration / info.timescale;
    }

    const codecDict: Record<string, string> = {};

    console.log('[TransmuxWorker] onReady step 1: info received', {
      duration: info.duration,
      timescale: info.timescale,
      tracksType: typeof info.tracks,
      isArray: Array.isArray(info.tracks)
    });

    if (info.tracks) {
      console.log('[TransmuxWorker] onReady step 2: iterating tracks');
      
      // Fallback in case info.tracks is not strictly an array but is iterable
      const tracksToIterate = Array.isArray(info.tracks) ? info.tracks : Object.values(info.tracks);
      
      for (const track of tracksToIterate) {
        if (!track || typeof track !== 'object') continue;
        
        console.log('[TransmuxWorker] onReady step 3: processing track id:', track.id);
        
        let codecStr = '';
        
        const isVideoArr = info.videoTracks && info.videoTracks.some((t: any) => String(t.id) === String(track.id));
        const isAudioArr = info.audioTracks && info.audioTracks.some((t: any) => String(t.id) === String(track.id));
        
        const isVideoCodec = track.codec && (track.codec.startsWith('avc') || track.codec.startsWith('hev') || track.codec.startsWith('hvc') || track.codec.startsWith('vp'));
        const isAudioCodec = track.codec && (track.codec.startsWith('mp4a') || track.codec.startsWith('opus') || track.codec.startsWith('flac'));
        
        const isVideo = isVideoArr || isVideoCodec || track.video;
        const isAudio = isAudioArr || isAudioCodec || track.audio;

        if (isVideo) {
          codecStr = 'video/mp4; codecs="' + track.codec + '"';
        } else if (isAudio) {
          codecStr = 'audio/mp4; codecs="' + track.codec + '"';
        } else {
          console.warn('[TransmuxWorker] onReady step 4: Skipping unknown track type:', track.id);
          continue;
        }

        console.log('[TransmuxWorker] onReady step 5: setting segment options for track', track.id, 'codecStr:', codecStr);
        codecDict[String(track.id)] = codecStr;
        mp4file.setSegmentOptions(track.id, null, { nbSamples: 35, rapAlign: true });
      }
    } else {
      console.warn('[TransmuxWorker] onReady step 2: info.tracks is missing!');
    }

    console.log('[TransmuxWorker] onReady step 6: initializing segmentation');
    const initSegs = mp4file.initializeSegmentation();
    console.log('[TransmuxWorker] onReady step 7: initSegs generated');

    s.initData = [];

    if (initSegs && initSegs.buffer) {
      let combinedCodec = 'video/mp4; codecs="';
      const codecs: string[] = [];
      for (const trackId of Object.keys(codecDict)) {
        const codecStr = codecDict[trackId];
        const match = codecStr.match(/codecs="(.*)"/);
        if (match) {
          codecs.push(match[1]);
        }
      }
      combinedCodec += codecs.join(', ') + '"';
      
      console.log('[TransmuxWorker] onReady step 8: Combined codec:', combinedCodec);
      
      s.initData.push({
        id: 0, // id 0 denotes the unified SourceBuffer
        codecString: combinedCodec,
        buffer: initSegs.buffer,
      });
    }

    mp4file.start();

    if (s.resolveReady) {
      s.resolveReady();
      s.resolveReady = null;
    }
  };

  // Called whenever mp4box has assembled a complete fMP4 segment.
  mp4file.onSegment = (id: number, user: any, buffer: ArrayBuffer) => {
    s.pendingSegments.push({ id: 0, buffer: buffer.slice(0) });
  };

  return s;
}

let bootstrapData: { chunk0: ArrayBuffer, moovBytes: ArrayBuffer | null, moovOffset?: number } | null = null;

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  const type = data.type;

  // Handle RESET message
  if (type === 'RESET') {
    state = null;
    return;
  }

  // Handle SEEK message
  if (type === 'SEEK') {
    const { time, generation } = data;
    if (bootstrapData) {
      console.log('[TransmuxWorker] Re-bootstrapping mp4file for pure state before seek...');
      state = createState();
      
      const { chunk0, moovBytes, moovOffset } = bootstrapData;
      
      const newChunk0 = chunk0.slice(0);
      (newChunk0 as any).fileStart = 0;
      state.mp4file.appendBuffer(newChunk0);
      
      if (moovBytes && typeof moovOffset === 'number') {
        const newMoov = moovBytes.slice(0);
        (newMoov as any).fileStart = moovOffset;
        state.mp4file.appendBuffer(newMoov);
      }

      await state.readyPromise;
      
      console.log('[TransmuxWorker] Seeking fresh mp4file to time:', time);
      const seekResult = state.mp4file.seek(time, true);
      const offset = seekResult.offset;
      const chunkIndex = Math.floor(offset / (4 * 1024 * 1024));
      
      self.postMessage({
        type: 'SEEK_COMPLETE',
        chunkIndex,
        generation
      });
    }
    return;
  }

  try {
    if (type === 'BOOTSTRAP') {
      const { chunk0, moovBytes, moovOffset, isLastChunk } = data as {
        chunk0: ArrayBuffer;
        moovBytes: ArrayBuffer | null;
        moovOffset?: number;
        isLastChunk?: boolean;
      };

      bootstrapData = { chunk0: chunk0.slice(0), moovBytes: moovBytes ? moovBytes.slice(0) : null, moovOffset };

      console.log('[TransmuxWorker] Received BOOTSTRAP message. chunk0 size:', chunk0.byteLength, 'hasMoovBytes:', !!moovBytes, 'moovOffset:', moovOffset);
      state = createState();

      // 1. Feed chunk 0 (which starts with the real ftyp box) at fileStart=0.
      (chunk0 as any).fileStart = 0;
      state.mp4file.appendBuffer(chunk0);

      // 2. Feed the extracted moov box at its real offset in the file if standard MP4.
      if (moovBytes && typeof moovOffset === 'number') {
        console.log('[TransmuxWorker] Feeding extracted moov box at real offset:', moovOffset);
        (moovBytes as any).fileStart = moovOffset;
        state.mp4file.appendBuffer(moovBytes);
      }

      console.log('[TransmuxWorker] BOOTSTRAP: awaiting readyPromise...');
      const timeout = new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error('MOOV_NOT_FOUND: mp4box onReady timed out after 5s during bootstrap.')), 5000)
      );
      await Promise.race([state.readyPromise, timeout]);
      console.log('[TransmuxWorker] BOOTSTRAP: readyPromise resolved!');

      if (isLastChunk) {
        console.log('[TransmuxWorker] BOOTSTRAP: isLastChunk is true, flushing mp4file!');
        state.mp4file.flush();
      }

      const outMessage: Record<string, any> = {
        type: 'BOOTSTRAP_COMPLETE',
        videoDuration: state.videoDuration,
      };

      const transferables: Transferable[] = [];
      if (state.initData) {
        outMessage['initData'] = state.initData;
        for (const item of state.initData) {
          transferables.push(item.buffer);
        }
        state.initData = null; // Prevent double-transfer.
      }

      const segments = state.pendingSegments.splice(0);
      outMessage['segments'] = segments;
      for (const seg of segments) {
        transferables.push(seg.buffer);
      }

      self.postMessage(outMessage, transferables);
      return;
    }

    if (type === 'TRANSMUX_CHUNK') {
      const { decryptedChunk, chunkIndex, isLastChunk } = data as {
        decryptedChunk: ArrayBuffer;
        chunkIndex: number;
        isLastChunk: boolean;
      };

      console.log('[TransmuxWorker] Received TRANSMUX_CHUNK. chunkIndex:', chunkIndex, 'byteLength:', decryptedChunk.byteLength);
      if (!state) {
        throw new Error('Worker was not bootstrapped. Call BOOTSTRAP first.');
      }

      (decryptedChunk as any).fileStart = chunkIndex * 4 * 1024 * 1024;
      state.mp4file.appendBuffer(decryptedChunk);

      if (isLastChunk) {
        state.mp4file.flush();
      }

      // Collect any segments generated by this chunk
      const segments = state.pendingSegments.splice(0);
      const transferables: Transferable[] = [];
      for (const seg of segments) {
        transferables.push(seg.buffer);
      }

      self.postMessage(
        {
          type: 'CHUNK_TRANSMUXED',
          segments,
          chunkIndex,
        },
        transferables
      );
      return;
    }
  } catch (err: any) {
    self.postMessage({
      type: 'ERROR',
      chunkIndex: data.chunkIndex ?? -1,
      message: err?.message ?? 'Unknown transmux error.',
    });
  }
};
