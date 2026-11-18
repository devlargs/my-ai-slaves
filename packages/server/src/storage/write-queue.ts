import { resolve } from "node:path";

const tails = new Map<string, Promise<unknown>>();

/**
 * Runs `job` after every job previously queued for the same file has settled.
 * One queue per absolute path, shared process-wide, so two objects touching the
 * same file can never interleave writes.
 */
export function enqueueFileJob<T>(file: string, job: () => Promise<T>): Promise<T> {
  const key = resolve(file);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(job, job);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
