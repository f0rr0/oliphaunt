import { throwCollectedCloseFailures } from './close.js';

export type ByteStream = {
  readExactly(length: number): Promise<Uint8Array>;
  writeAll(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

export class MemoryDuplexStream implements ByteStream {
  readonly #input: Uint8Array[];
  readonly output: Uint8Array[] = [];

  constructor(input: ReadonlyArray<Uint8Array> = []) {
    this.#input = [...input];
  }

  async readExactly(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.#input[0];
      if (chunk === undefined) {
        throw new Error(`read stream ended before ${length} byte(s) were available`);
      }
      const take = Math.min(chunk.length, length - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.length) {
        this.#input.shift();
      } else {
        this.#input[0] = chunk.subarray(take);
      }
    }
    return out;
  }

  async writeAll(bytes: Uint8Array): Promise<void> {
    this.output.push(bytes.slice());
  }

  async close(): Promise<void> {}
}

/** Bound a control phase by closing the transport, then await its I/O settlement. */
export async function withStreamDeadline<T>(
  stream: ByteStream,
  deadline: number,
  operation: () => Promise<T>,
  label: string,
): Promise<T> {
  const failures: unknown[] = [];
  const timeoutError = new Error(`${label} deadline exceeded`);
  let expired = false;
  let closing: Promise<void> | undefined;
  const expire = () => {
    expired = true;
    closing = Promise.resolve()
      .then(() => stream.close())
      .catch((error) => {
        failures.push(error);
      });
  };
  const remaining = deadline - performance.now();
  const timer = remaining > 0 ? setTimeout(expire, remaining) : undefined;
  if (remaining <= 0) expire();
  const [outcome] = await Promise.allSettled([
    expired ? Promise.reject(timeoutError) : Promise.resolve().then(operation),
  ]);
  clearTimeout(timer);
  await closing;
  if (expired) failures.unshift(timeoutError);
  if (outcome.status === 'rejected' && outcome.reason !== timeoutError)
    failures.push(outcome.reason);
  throwCollectedCloseFailures(failures, `${label} failed`);
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}
