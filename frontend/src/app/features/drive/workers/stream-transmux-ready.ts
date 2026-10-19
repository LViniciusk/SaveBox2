type ReadyTrackInfo = {
  duration?: number;
  timescale?: number;
  tracks?: unknown[] | Record<string, unknown> | null;
  videoTracks?: Array<{ id: unknown }>;
  audioTracks?: Array<{ id: unknown }>;
};

type SegmentOptions = {
  nbSamples: 35;
  rapAlignement: true;
};

type ReadyState = {
  videoDuration: number | null;
  initData: Array<{ id: number; codecString: string; buffer: ArrayBuffer }> | null;
  resolveReady: (() => void) | null;
  terminalError?: Error | null;
};

type ReadyMp4File = {
  setSegmentOptions(trackId: unknown, user: null, options: SegmentOptions): void;
  initializeSegmentation(): { buffer?: ArrayBuffer } | null | undefined;
  start(): void;
};

const RECOGNIZED_CODEC_PREFIXES = ['avc', 'hev', 'hvc', 'vp', 'mp4a', 'opus', 'flac'];

function isRecognizedTrack(info: ReadyTrackInfo, track: any): boolean {
  const id = String(track.id);

  return Boolean(
    info.videoTracks?.some((item) => String(item.id) === id) ||
    info.audioTracks?.some((item) => String(item.id) === id) ||
    (track.codec && RECOGNIZED_CODEC_PREFIXES.some((prefix) => track.codec.startsWith(prefix))) ||
    track.video ||
    track.audio,
  );
}

export function handleTransmuxReady(
  info: ReadyTrackInfo,
  state: ReadyState,
  mp4file: ReadyMp4File,
  startProcessing = true,
): void {
  if (state.terminalError) return;

  const codecsByTrackId: Record<string, string> = {};
  const videoDuration = info.duration && info.timescale ? info.duration / info.timescale : undefined;

  if (videoDuration !== undefined) {
    state.videoDuration = videoDuration;
  }

  if (!info.tracks) {
    console.warn('[TransmuxWorker] onReady step 2: info.tracks is missing!');
  } else {
    const tracksToIterate = Array.isArray(info.tracks) ? info.tracks : Object.values(info.tracks);

    for (const track of tracksToIterate) {
      if (!track || typeof track !== 'object') continue;

      const candidate = track as any;
      if (!isRecognizedTrack(info, candidate)) {
        console.warn('[TransmuxWorker] onReady step 4: Skipping unknown track type:', candidate.id);
        continue;
      }

      codecsByTrackId[String(candidate.id)] = String(candidate.codec);
      mp4file.setSegmentOptions(candidate.id, null, { nbSamples: 35, rapAlignement: true });
    }
  }

  const initSegs = mp4file.initializeSegmentation();
  state.initData = [];

  if (initSegs && initSegs.buffer) {
    const combinedCodec = 'video/mp4; codecs="' +
      Object.keys(codecsByTrackId).map((trackId) => codecsByTrackId[trackId]).join(', ') + '"';

    state.initData.push({
      id: 0,
      codecString: combinedCodec,
      buffer: initSegs.buffer,
    });
  }

  if (startProcessing) mp4file.start();

  if (state.resolveReady) {
    state.resolveReady();
    state.resolveReady = null;
  }
}
