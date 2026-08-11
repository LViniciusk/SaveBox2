import { Observable, Subscription } from 'rxjs';
import { UploadAbortError } from './upload.models';

export class NetworkDeadlineError extends Error {
  constructor() {
    super('Network request deadline exceeded');
    this.name = 'NetworkDeadlineError';
  }
}

export function firstValueFromAbortable<T>(source: Observable<T>, signal?: AbortSignal, deadlineMs?: number): Promise<T> {
  if (signal?.aborted) return Promise.reject(new UploadAbortError());
  if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647)) {
    return Promise.reject(new RangeError('deadlineMs must be positive and within the finite timer range'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: Subscription | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      subscription?.unsubscribe();
      callback();
    };
    const onAbort = () => settle(() => reject(new UploadAbortError()));

    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadlineMs !== undefined) {
      deadlineTimer = setTimeout(() => settle(() => reject(new NetworkDeadlineError())), deadlineMs);
    }
    subscription = source.subscribe({
      next: value => settle(() => resolve(value)),
      error: error => settle(() => reject(error)),
      complete: () => settle(() => reject(new Error('Observable completed without a value'))),
    });

    if (settled) subscription.unsubscribe();
    else if (signal?.aborted) onAbort();
  });
}

export function isUploadAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
