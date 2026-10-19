import { Observable, of, Subject, throwError } from 'rxjs';
import { firstValueFromAbortable, NetworkDeadlineError } from './abortable-observable';
import { UploadAbortError } from './upload.models';

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
    const teardown = jasmine.createSpy('teardown');
    const source = new Observable<number>(subscriber => {
      controller.abort();
      subscriber.next(9);
      return teardown;
    });

    await expectAsync(firstValueFromAbortable(source, controller.signal)).toBeRejectedWithError('Upload cancelled');
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  describe('B.94 finite deadline authority', () => {
    beforeEach(() => jasmine.clock().install());
    afterEach(() => jasmine.clock().uninstall());

    it('B.94 settles and unsubscribes exactly at the deadline', async () => {
      const controller = new AbortController();
      const teardown = jasmine.createSpy('teardown');
      let error: Error | undefined;
      const result = firstValueFromAbortable(new Observable(() => teardown), controller.signal, 1000).catch(value => { error = value; });
      jasmine.clock().tick(999);
      await Promise.resolve();
      expect(error).toBeUndefined();
      jasmine.clock().tick(1);
      await Promise.resolve();
      expect(error?.name).toBe('NetworkDeadlineError');
      expect(teardown).toHaveBeenCalledTimes(1);
      controller.abort();
      await result;
    });

    it('B.94 keeps deadline as the winner over late abort and next', async () => {
      const source = new Subject<number>();
      const controller = new AbortController();
      const rejected = jasmine.createSpy('rejected');
      const resolved = jasmine.createSpy('resolved');
      const result = firstValueFromAbortable(source, controller.signal, 10).then(resolved, rejected);
      jasmine.clock().tick(10);
      await Promise.resolve();
      expect(source.observed).toBeFalse();
      controller.abort();
      source.next(3);
      await result;
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(rejected.calls.mostRecent().args[0].name).toBe('NetworkDeadlineError');
      expect(resolved).not.toHaveBeenCalled();
    });

    it('B.94 keeps owner abort distinct and clears the deadline', async () => {
      const controller = new AbortController();
      const teardown = jasmine.createSpy('teardown');
      const originalClear = globalThis.clearTimeout;
      const clear = jasmine.createSpy('clearTimeout').and.callFake(originalClear);
      globalThis.clearTimeout = clear;
      try {
        const result = firstValueFromAbortable(new Observable(() => teardown), controller.signal, 1000);
        controller.abort();
        await expectAsync(result).toBeRejectedWithError('Upload cancelled');
        expect(clear).toHaveBeenCalledTimes(1);
        jasmine.clock().tick(1000);
        expect(teardown).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.clearTimeout = originalClear;
      }
    });

    for (const deadline of [0, -1, NaN, Infinity, -Infinity, 2_147_483_648]) {
      it(`B.94 rejects invalid deadline ${deadline} before subscription`, async () => {
        let subscribed = false;
        let error: Error | undefined;
        const controller = new AbortController();
        const result = firstValueFromAbortable(new Observable(() => { subscribed = true; }), controller.signal, deadline).catch(value => { error = value; });
        await Promise.resolve();
        expect(subscribed).toBeFalse();
        expect(error instanceof RangeError).toBeTrue();
        controller.abort();
        await result;
      });
    }

    it('B.94 tears down a synchronous first value without requiring source completion', async () => {
      const teardown = jasmine.createSpy('teardown');
      await expectAsync(firstValueFromAbortable(new Observable<number>(subscriber => {
        subscriber.next(4);
        return teardown;
      }), undefined, 10)).toBeResolvedTo(4);
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    for (const winner of ['value', 'error', 'complete']) {
      it(`B.94 releases timer and listener when ${winner} precedes the deadline`, async () => {
        const controller = new AbortController();
        const source = new Subject<number>();
        const remove = spyOn(controller.signal, 'removeEventListener').and.callThrough();
        const originalClear = globalThis.clearTimeout;
        const clear = jasmine.createSpy('clearTimeout').and.callFake(originalClear);
        globalThis.clearTimeout = clear;
        try {
          const resolved = jasmine.createSpy('resolved');
          const rejected = jasmine.createSpy('rejected');
          const result = firstValueFromAbortable(source, controller.signal, 10).then(resolved, rejected);
          if (winner === 'value') source.next(5);
          else if (winner === 'error') source.error(new Error('synthetic failure'));
          else source.complete();
          await result;
          expect(source.observed).toBeFalse();
          expect(clear).toHaveBeenCalledTimes(1);
          expect(remove).toHaveBeenCalledTimes(1);
          jasmine.clock().tick(10);
          controller.abort();
          expect(resolved.calls.count() + rejected.calls.count()).toBe(1);
          if (winner === 'value') expect(resolved).toHaveBeenCalledOnceWith(5);
          else expect(rejected.calls.mostRecent().args[0]).not.toBeInstanceOf(NetworkDeadlineError);
        } finally {
          globalThis.clearTimeout = originalClear;
        }
      });
    }

    it('B.94 allocates no timer without an explicit deadline', async () => {
      const originalSet = globalThis.setTimeout;
      const set = jasmine.createSpy('setTimeout').and.callFake(originalSet);
      globalThis.setTimeout = set;
      try {
        const source = new Subject<number>();
        const controller = new AbortController();
        const result = firstValueFromAbortable(source, controller.signal);
        expect(set).not.toHaveBeenCalled();
        jasmine.clock().tick(86_400_000);
        expect(source.observed).toBeTrue();
        controller.abort();
        await expectAsync(result).toBeRejectedWith(jasmine.any(UploadAbortError));
      } finally {
        globalThis.setTimeout = originalSet;
      }
    });

    it('B.94 keeps pre-abort distinct and avoids both subscription and timer', async () => {
      const controller = new AbortController();
      controller.abort();
      const subscribe = jasmine.createSpy('subscribe');
      await expectAsync(firstValueFromAbortable(new Observable(subscribe), controller.signal, 10))
        .toBeRejectedWith(jasmine.any(UploadAbortError));
      expect(subscribe).not.toHaveBeenCalled();
    });
  });
});
