/** Thrown (internally) when a pending operation is abandoned because the run was cancelled. */
export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled by user.');
    this.name = 'RunCancelledError';
  }
}

/**
 * Settles with `promise`, or rejects with {@link RunCancelledError} as soon as `signal` aborts,
 * whichever happens first. It does not rely on the underlying operation honoring the signal, so
 * a client or handler that ignores it cannot keep a cancelled run hanging. The abandoned promise's
 * eventual outcome is swallowed (no unhandled rejection).
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new RunCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RunCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
