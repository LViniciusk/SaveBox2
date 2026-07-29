import { isUploadAbortError } from './abortable-observable';

export interface UploadQueueTask<T> {
  run: () => Promise<T>;
  signal?: AbortSignal;
}

export class UploadQueue {
  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Upload queue concurrency must be at least 1');
    }
  }

  async run<T>(tasks: readonly (UploadQueueTask<T> | (() => Promise<T>))[], signal?: AbortSignal): Promise<T[]> {
    const results = new Array<T>(tasks.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        if (signal?.aborted) return;
        const index = next++;
        const task = tasks[index];
        const run = typeof task === 'function' ? task : task.run;
        const taskSignal = typeof task === 'function' ? undefined : task.signal;
        if (signal?.aborted || taskSignal?.aborted) continue;
        try {
          results[index] = await run();
        } catch (error) {
          if (!isUploadAbortError(error)) throw error;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, () => worker()));
    return results;
  }
}
