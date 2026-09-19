import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

export const availableWorkers = () => availableParallelism();

export function validateJobs(jobs) {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('jobs must be a positive integer');
}

export async function mapConcurrent(items, jobs, operation) {
  validateJobs(jobs);
  const values = Array.from(items);
  const results = new Array(values.length);
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(jobs, values.length) }, async () => {
    while (!failure && next < values.length) {
      const index = next++;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  }));
  if (failure) throw failure;
  return results;
}

export async function mapWorkers(task, items, jobs = availableWorkers()) {
  validateJobs(jobs);
  const values = Array.from(items);
  if (!values.length) return [];
  const results = new Array(values.length);
  const workers = [];
  let next = 0;
  let completed = 0;
  let settled = false;
  return new Promise((resolve, reject) => {
    const finish = async error => {
      if (settled) return;
      settled = true;
      await Promise.allSettled(workers.map(worker => worker.terminate()));
      if (error) reject(error);
      else resolve(results);
    };
    const dispatch = worker => {
      if (!settled && next < values.length) {
        const index = next++;
        worker.postMessage({ task, index, item: values[index] });
      }
    };
    try {
      for (let index = 0; index < Math.min(jobs, values.length); index++) {
        const worker = new Worker(new URL('./worker.mjs', import.meta.url));
        workers.push(worker);
        worker.on('message', message => {
          if (settled) return;
          if (message.error) {
            const error = new Error(message.error.message);
            error.name = message.error.name;
            error.stack = message.error.stack;
            void finish(error);
            return;
          }
          results[message.index] = message.result;
          completed++;
          if (completed === values.length) void finish();
          else dispatch(worker);
        });
        worker.on('error', error => void finish(error));
        worker.on('exit', code => {
          if (!settled) void finish(new Error(`Worker exited before completing its task (code ${code})`));
        });
        dispatch(worker);
      }
    } catch (error) {
      void finish(error);
    }
  });
}
