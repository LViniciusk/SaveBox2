import { UploadQueue } from './upload-queue';

describe('UploadQueue', () => {
  it('rejects invalid concurrency', () => {
    expect(() => new UploadQueue(0)).toThrowError(/at least 1/);
  });

  it('limits concurrent tasks to one', async () => {
    const queue = new UploadQueue(1);
    let active = 0;
    let maximum = 0;

    const result = await queue.run([1, 2, 3].map(value => async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return value;
    }));

    expect(result).toEqual([1, 2, 3]);
    expect(maximum).toBe(1);
  });

  it('limits concurrent tasks to two', async () => {
    const queue = new UploadQueue(2);
    let active = 0;
    let maximum = 0;

    await queue.run([1, 2, 3, 4].map(value => async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return value;
    }));

    expect(maximum).toBe(2);
  });

  it('accepts an empty task list', async () => {
    await expectAsync(new UploadQueue(2).run([])).toBeResolvedTo([]);
  });

  it('does not start a task whose signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const task = jasmine.createSpy('cancelled task').and.resolveTo(1);

    await new UploadQueue(1).run([{ run: task, signal: controller.signal }]);

    expect(task).not.toHaveBeenCalled();
  });

  it('stops taking new tasks after the group signal aborts while active work settles', async () => {
    const controller = new AbortController();
    const first = jasmine.createSpy('first').and.callFake(async () => {
      controller.abort();
      await Promise.resolve();
      return 1;
    });
    const second = jasmine.createSpy('second').and.resolveTo(2);

    await new UploadQueue(1).run([first, second], controller.signal);

    expect(first).toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('does not turn an AbortError into an unhandled queue rejection', async () => {
    const task = () => Promise.reject(new DOMException('cancelled', 'AbortError'));

    const result = await new UploadQueue(1).run([task]);
    expect(result[0]).toBeUndefined();
  });
});
