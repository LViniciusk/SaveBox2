export interface SegmentOutputState {
  terminalError?: Error | null;
  pendingSegments: Array<{
    id: number;
    buffer: ArrayBuffer;
  }>;
}

export interface UsedSampleReleaser {
  releaseUsedSamples(trackId: number, sampleNumber: number): void;
}

export function handleTransmuxSegment(
  state: SegmentOutputState,
  mp4file: UsedSampleReleaser,
  trackId: number,
  buffer: ArrayBuffer,
  sampleNumber: number,
): void {
  if (state.terminalError) return;

  state.pendingSegments.push({ id: 0, buffer: buffer.slice(0) });
  mp4file.releaseUsedSamples(trackId, sampleNumber);
}
