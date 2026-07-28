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
});
