import { Observable, Subscription } from 'rxjs';
import { UploadAbortError } from './upload.models';

export function firstValueFromAbortable<T>(source: Observable<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new UploadAbortError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: Subscription | undefined;

    const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      callback();
    };
    const onAbort = () => {
      subscription?.unsubscribe();
      settle(() => reject(new UploadAbortError()));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    subscription = source.subscribe({
      next: value => settle(() => {
        subscription?.unsubscribe();
        resolve(value);
      }),
      error: error => settle(() => reject(error)),
      complete: () => settle(() => reject(new Error('Observable completed without a value'))),
    });

    if (signal?.aborted) onAbort();
  });
}

export function isUploadAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
