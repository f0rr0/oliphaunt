import { timeoutMilliseconds } from '@oliphaunt/ts-query/internal/resource-options';

export const DEFAULT_BROWSER_STARTUP_TIMEOUT_MS = 120_000;

/** Wait only for immutable preparation this way; owned allocations must be cleaned up by their caller. */
export function observePreparation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export class StartupBudget {
  readonly #controller = new AbortController();
  readonly #deadline: number;
  readonly #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #error: Error;

  constructor(milliseconds: number | undefined, label = 'Oliphaunt WASIX startup') {
    if (milliseconds !== undefined) timeoutMilliseconds(milliseconds, 'startupTimeoutMs');
    this.#deadline = milliseconds === undefined ? Infinity : performance.now() + milliseconds;
    this.#error = new Error(`${label} exceeded ${milliseconds}ms`);
    this.#timer =
      milliseconds === undefined
        ? undefined
        : setTimeout(() => this.#controller.abort(this.#error), milliseconds);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get remaining(): number {
    return Math.max(0, Math.ceil(this.#deadline - performance.now()));
  }

  check(): void {
    if (this.remaining === 0) this.#controller.abort(this.#error);
    this.signal.throwIfAborted();
  }

  prepare<T>(operation: Promise<T>): Promise<T> {
    if (this.remaining === 0) this.#controller.abort(this.#error);
    return observePreparation(operation, this.signal).then((value) => {
      // A settled microtask can run before an overdue timer after host work blocks.
      this.check();
      return value;
    });
  }

  finish(): void {
    clearTimeout(this.#timer);
  }
}
