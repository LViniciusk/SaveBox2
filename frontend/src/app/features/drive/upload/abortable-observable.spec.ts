import { Observable, of, throwError } from 'rxjs';
import { firstValueFromAbortable } from './abortable-observable';

describe('firstValueFromAbortable', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expectAsync(firstValueFromAbortable(of(1), controller.signal)).toBeRejectedWithError('Upload cancelled');
  });

  it('resolves values and propagates source errors', async () => {
    await expectAsync(firstValueFromAbortable(of(7))).toBeResolvedTo(7);
    await expectAsync(firstValueFromAbortable(throwError(() => new Error('offline')))).toBeRejectedWithError('offline');
  });

  it('rejects an empty observable and unsubscribes on abort', async () => {
    await expectAsync(firstValueFromAbortable(new Observable<void>(subscriber => subscriber.complete())))
      .toBeRejectedWithError('Observable completed without a value');

    const controller = new AbortController();
    let unsubscribed = false;
    const source = new Observable<number>(() => () => { unsubscribed = true; });
    const promise = firstValueFromAbortable(source, controller.signal);
    controller.abort();

    await expectAsync(promise).toBeRejectedWithError('Upload cancelled');
    expect(unsubscribed).toBeTrue();
  });

  it('handles a signal aborted synchronously while subscribing', async () => {
    const controller = new AbortController();
    const source = new Observable<number>(() => {
      controller.abort();
      return undefined;
    });

    await expectAsync(firstValueFromAbortable(source, controller.signal)).toBeRejectedWithError('Upload cancelled');
  });
});
