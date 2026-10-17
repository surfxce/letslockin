import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Cancelling the job the worker is running. The worker runs each job inside its own
 * signal; every model call reads it from here, so a cancelled job stops wherever it is —
 * a CLI is killed, an offline model stops mid-answer, a request is aborted. Side lanes
 * (asks, sorting, downloads) run outside it and are never touched.
 */
const store = new AsyncLocalStorage<AbortSignal>();

export class JobCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelled";
  }
}

export function runCancellable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return store.run(signal, work);
}

/** The signal of the job this call belongs to, if any. */
export function jobSignal(): AbortSignal | undefined {
  return store.getStore();
}

export function throwIfCancelled() {
  if (jobSignal()?.aborted) throw new JobCancelled();
}

/** A timeout that also ends when the job is cancelled. */
export function timeoutOrCancel(ms: number): AbortSignal {
  const signal = jobSignal();
  return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
}

/** Kills a child process when the job is cancelled; returns the unhook. */
export function killOnCancel(child: { kill(signal?: NodeJS.Signals): boolean }, onCancel: () => void): () => void {
  const signal = jobSignal();
  if (!signal) return () => undefined;
  const abort = () => {
    child.kill("SIGKILL");
    onCancel();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
