import { Observable } from 'rxjs';

export interface RangeFixture { id: number; ciphertextBytes: number; }
export interface RangeCounters {
  rangeRequestsStarted: number; rangeRequestsCompleted: number; rangeRequestsAborted: number;
  rangeRequestsFailed: number; rangeBytesReceived: number; pendingOperations: number;
  activeRanges: number; maxActiveRanges: number; metadataRequests: number;
}

export function validateBounds(start: number, end: number, total: number): void {
  if (![start, end, total].every(Number.isSafeInteger) || total <= 0 || start < 0 || end < start || end >= total) {
    throw new Error('INVALID_RANGE_BOUNDS');
  }
}

export function parseRangeHeader(range: string, total: number) {
  const match = /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(range);
  if (!match) throw new Error('INVALID_RANGE_HEADER');
  const start = Number(match[1]), end = Number(match[2]);
  validateBounds(start, end, total);
  return { start, end };
}

export function validatePartialResponse(response: { status: number; headers: { get(name: string): string | null } }, start: number, end: number, total: number): void {
  validateBounds(start, end, total);
  if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${total}` ||
      response.headers.get('Content-Length') !== String(end - start + 1)) throw new Error('INVALID_RANGE_RESPONSE');
}

// The same adapter serves metadata and chunk reads; no public-share or external transport exists here.
export function rangeAdapter(fixtures: readonly RangeFixture[], counters: RangeCounters, transport: typeof fetch = fetch) {
  const sizes = new Map(fixtures.map(fixture => [fixture.id, fixture.ciphertextBytes]));
  if (sizes.size !== 3 || ![0, 1, 2].every(id => sizes.has(id))) throw new Error('INVALID_FIXTURE_WHITELIST');
  return {
    downloadFileRange(id: number, start: number, end: number): Observable<Blob> {
      const total = sizes.get(id);
      if (total === undefined) throw new Error('FORBIDDEN_FIXTURE_ID');
      validateBounds(start, end, total);
      return new Observable<Blob>(subscriber => {
        const controller = new AbortController();
        let settled = false;
        counters.rangeRequestsStarted++; counters.pendingOperations++; counters.activeRanges++;
        counters.maxActiveRanges = Math.max(counters.maxActiveRanges, counters.activeRanges);
        if (start === 0) counters.metadataRequests++;
        void (async () => {
          try {
            const response = await transport(`/video-${id}.mp4`, { signal: controller.signal,
              cache: 'no-store', headers: { Range: `bytes=${start}-${end}` } });
            validatePartialResponse(response, start, end, total);
            const blob = await response.blob();
            counters.rangeBytesReceived += blob.size;
            if (blob.size !== end - start + 1) throw new Error('TRUNCATED_RANGE_BODY');
            if (subscriber.closed || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            settled = true; counters.rangeRequestsCompleted++;
            subscriber.next(blob); subscriber.complete();
          } catch (error) {
            settled = true;
            if (controller.signal.aborted) counters.rangeRequestsAborted++;
            else counters.rangeRequestsFailed++;
            if (!subscriber.closed) subscriber.error(error);
          } finally { counters.pendingOperations--; counters.activeRanges--; }
        })();
        return () => { if (!settled) controller.abort(); };
      });
    },
  };
}
