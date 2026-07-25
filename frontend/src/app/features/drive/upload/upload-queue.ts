export class UploadQueue {
  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Upload queue concurrency must be at least 1');
    }
  }

  async run<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
    const results = new Array<T>(tasks.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, () => worker()));
    return results;
  }
}
