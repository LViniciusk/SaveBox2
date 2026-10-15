import { Observable } from 'rxjs';
import { validateBounds, validatePartialResponse, RangeCounters } from './range-adapter';

export type R9Transport = 'xhr' | 'angular-fetch' | 'direct-fetch';
export function selectTransport(value: unknown): R9Transport | null {
  if (value === undefined) return null;
  if (value === 'xhr' || value === 'angular-fetch' || value === 'direct-fetch') return value;
  throw new Error('R9_INVALID_TRANSPORT');
}

export interface DirectCounters extends RangeCounters {
  outstandingSubscriptions: number; http206Validated: number; directAuthorizedRanges: number;
}

export function directRange(id: number, start: number, end: number,
  files: readonly { id: number; ciphertextBytes: number }[], token: () => string | null,
  counters: DirectCounters, transport: typeof fetch = fetch): Observable<Blob> {
  const file = files.find(row => row.id === id);
  if (!file || !Number.isSafeInteger(id) || id <= 0) throw new Error('R9_FORBIDDEN_FILE_ID');
  validateBounds(start, end, file.ciphertextBytes);
  return new Observable(subscriber => {
    const jwt = token();
    if (!jwt) { subscriber.error(new Error('R9_SESSION_TOKEN_REQUIRED')); return; }
    const controller = new AbortController();
    let settled = false;
    counters.rangeRequestsStarted++; counters.pendingOperations++; counters.activeRanges++;
    counters.outstandingSubscriptions++; counters.directAuthorizedRanges++;
    counters.maxActiveRanges = Math.max(counters.maxActiveRanges, counters.activeRanges);
    if (start === 0) counters.metadataRequests++;
    void (async () => {
      try {
        const response = await transport(`http://127.0.0.1:42187/files/${id}/download`, {
          method: 'GET', credentials: 'include', redirect: 'error', cache: 'default', signal: controller.signal,
          headers: { Authorization: `Bearer ${jwt}`, Range: `bytes=${start}-${end}` },
        });
        if (response.redirected) throw new Error('R9_REDIRECT_FORBIDDEN');
        validatePartialResponse(response, start, end, file.ciphertextBytes);
        const blob = await response.blob();
        if (blob.size !== end - start + 1) throw new Error('TRUNCATED_RANGE_BODY');
        if (controller.signal.aborted || subscriber.closed) throw new DOMException('Aborted', 'AbortError');
        settled = true; counters.rangeRequestsCompleted++; counters.http206Validated++;
        counters.rangeBytesReceived += blob.size;
        subscriber.next(blob); subscriber.complete();
      } catch (error) {
        settled = true;
        if (controller.signal.aborted) counters.rangeRequestsAborted++;
        else counters.rangeRequestsFailed++;
        if (!subscriber.closed) subscriber.error(error);
      } finally {
        counters.pendingOperations--; counters.activeRanges--; counters.outstandingSubscriptions--;
      }
    })();
    return () => { if (!settled) controller.abort(); };
  });
}
