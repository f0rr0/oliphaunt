import { extendedQuery, toUint8Array } from './query.js';

// BEGIN uses extended-query framing. Derive its fixed packet size from the encoder.
export const TRANSACTION_BEGIN_REQUEST_BYTES = extendedQuery('BEGIN', []).byteLength;

// Active work stays charged until its owner's closure settles, including cleanup.
const DEFAULT_MAX_PENDING_OPERATIONS = 64;
// Retention watermark: one larger operation is allowed when admission is empty.
const DEFAULT_HIGH_WATER_MARK_BYTES = 128 * 1024 * 1024;

/** Pending preparation, queued and executing work for one database owner. */
export type AdmissionLimits = Readonly<{
  maxPendingOperations: number;
  /** Conservative retained input allowance; a larger operation runs alone. */
  highWaterMarkBytes: number;
}>;

/** Snapshot before loading resources or publishing an owner. Both fields are required. */
export function normalizeAdmissionLimits(
  value: AdmissionLimits | undefined,
): AdmissionLimits | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'maxPendingOperations' && key !== 'highWaterMarkBytes')
  ) {
    throw new TypeError('admission requires maxPendingOperations and highWaterMarkBytes');
  }
  const { maxPendingOperations, highWaterMarkBytes } = value;
  if (
    !Number.isSafeInteger(maxPendingOperations) ||
    maxPendingOperations <= 0 ||
    !Number.isSafeInteger(highWaterMarkBytes) ||
    highWaterMarkBytes <= 0
  ) {
    throw new RangeError('admission limits must be positive safe integers');
  }
  return Object.freeze({ maxPendingOperations, highWaterMarkBytes });
}

/** Internal accounting only; execution order and deadlines belong to each SDK. */
export class OperationBudget {
  #count = 0;
  #bytes = 0;
  readonly #limits: AdmissionLimits;
  readonly configured: boolean;

  constructor(limits?: AdmissionLimits) {
    this.configured = limits !== undefined;
    this.#limits = normalizeAdmissionLimits(limits) ?? {
      maxPendingOperations: DEFAULT_MAX_PENDING_OPERATIONS,
      highWaterMarkBytes: DEFAULT_HIGH_WATER_MARK_BYTES,
    };
  }

  /** Reserve a conservative encoded allowance before allocating a packet. */
  snapshotEncodedInput(
    retain: (bytes: number) => void,
    allowance: number,
    encode: () => Uint8Array,
  ): Uint8Array {
    if (this.configured) retain(allowance);
    const input = encode();
    if (!this.configured) retain(input.byteLength);
    return input;
  }

  admit<T>(
    prepare: (retain: (bytes: number) => void, release: () => void) => Promise<T>,
    settled: () => Promise<unknown>,
  ): Promise<T> {
    if (
      this.#count >= this.#limits.maxPendingOperations ||
      this.#bytes >= this.#limits.highWaterMarkBytes
    ) {
      throw new Error('Oliphaunt operation queue is full; wait for pending work to finish');
    }
    this.#count++;
    let retained = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#count--;
      this.#bytes -= retained;
    };
    try {
      const operation = prepare((bytes) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new RangeError('invalid retained byte count');
        // One large operation retains its existing input limit and runs alone.
        if (this.#count > 1 && bytes > this.#limits.highWaterMarkBytes - this.#bytes) {
          throw new Error('Oliphaunt operation queue is full; wait for pending work to finish');
        }
        if (!Number.isSafeInteger(this.#bytes + bytes))
          throw new RangeError('retained byte count exceeds safe integer range');
        retained += bytes;
        this.#bytes += bytes;
      }, release);
      // Owners can release at a shorter stage boundary, such as BEGIN before its
      // callback. The tail remains a fallback for work skipped before execution.
      // Expiry can reject a caller before its queued closure releases the input.
      void settled().then(release, release);
      // Let an already-settled owner tail release before the caller resumes.
      // An early expiry still rejects without waiting for that tail.
      return this.configured ? operation.then((value) => value) : operation;
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
