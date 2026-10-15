import { toUint8Array } from './query.js';

const MAX_PENDING_OPERATIONS = 64;
const MAX_PENDING_BYTES = 128 * 1024 * 1024;

/** Internal accounting only; execution order and deadlines belong to each SDK. */
export class OperationBudget {
  #count = 0;
  #bytes = 0;

  admit<T>(
    prepare: (retain: (bytes: number) => void) => Promise<T>,
    settled: () => Promise<unknown>,
  ): Promise<T> {
    if (this.#count >= MAX_PENDING_OPERATIONS || this.#bytes >= MAX_PENDING_BYTES) {
      throw new Error('Oliphaunt operation queue is full; wait for pending work to finish');
    }
    this.#count++;
    let retained = 0;
    const release = () => {
      this.#count--;
      this.#bytes -= retained;
    };
    try {
      const operation = prepare((bytes) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new RangeError('invalid retained byte count');
        // One large operation retains its existing input limit and runs alone.
        if (this.#count > 1 && bytes > MAX_PENDING_BYTES - this.#bytes) {
          throw new Error('Oliphaunt operation queue is full; wait for pending work to finish');
        }
        retained += bytes;
        this.#bytes += bytes;
      });
      // Expiry can reject a caller before its queued closure releases the input.
      void settled().then(release, release);
      return operation;
    } catch (error) {
      release();
      throw error;
    }
  }
}

export function snapshotProtocolInput(
  input: Parameters<typeof toUint8Array>[0],
  retain: (bytes: number) => void,
): Uint8Array {
  if (Array.isArray(input)) {
    retain(input.length);
    return toUint8Array(input);
  }
  const bytes = toUint8Array(input);
  retain(bytes.byteLength);
  return bytes.slice();
}
