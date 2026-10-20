import type { ByteStream } from './byte-stream.js';
import {
  BROKER_EXCHANGE_CHUNK_BYTES,
  type BrokerCompletion,
  decodeBrokerCompletion,
  encodeBrokerExchangeFrame,
  readBrokerExchangeFrame,
} from './broker-frames.js';

/** Internal native outcome; PostgreSQL ErrorResponse bytes stay in the raw stream. */
export class BrokerExchangeError extends Error {
  readonly reason: BrokerCompletion['reason'];
  readonly execution: BrokerCompletion['execution'];
  readonly requiresReopen: boolean;

  constructor(completion: BrokerCompletion) {
    super(completion.detail || `native broker exchange ${completion.reason}`);
    this.reason = completion.reason;
    this.execution = completion.execution;
    this.requiresReopen = completion.requiresReopen;
  }
}

/** One native operation owns both directions until its matching terminal record. */
export class BrokerExchangeClient {
  readonly #epoch: Uint8Array;
  #nextRequest = 1n;
  #activeRequest: bigint | undefined;
  #closed = false;

  constructor(
    private readonly stream: ByteStream,
    epoch: Uint8Array,
  ) {
    if (epoch.length !== 16) throw new Error('invalid broker exchange generation');
    this.#epoch = epoch.slice();
  }

  static async open(stream: ByteStream): Promise<BrokerExchangeClient> {
    const frame = await readBrokerExchangeFrame(stream);
    if (frame.kind !== 6 || frame.request !== 0n)
      throw new Error('native broker omitted exchange negotiation acknowledgement');
    const completion = decodeBrokerCompletion(frame.payload);
    if (completion.reason !== 'success') throw new BrokerExchangeError(completion);
    return new BrokerExchangeClient(stream, frame.epoch);
  }

  get activeRequest(): { epoch: Uint8Array; request: bigint } | undefined {
    return this.#activeRequest === undefined
      ? undefined
      : { epoch: this.#epoch.slice(), request: this.#activeRequest };
  }

  async execProtocolStream(input: Uint8Array, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    if (this.#closed) throw new Error('native broker SQL connection is closed');
    if (this.#activeRequest !== undefined)
      throw new Error('native broker exchange is already active');
    validateInput(input);
    if (this.#nextRequest > 0xffff_ffff_ffff_ffffn)
      throw new Error('native broker request ids exhausted; reopen the database');
    const request = this.#nextRequest++;
    this.#activeRequest = request;
    let callbackFailure: { error: unknown } | undefined;
    const write = async () => {
      const start = new Uint8Array(16);
      new DataView(start.buffer).setBigUint64(0, BigInt(input.length));
      await this.stream.writeAll(
        encodeBrokerExchangeFrame({ kind: 1, epoch: this.#epoch, request, payload: start }),
      );
      for (let offset = 0; offset < input.length; offset += BROKER_EXCHANGE_CHUNK_BYTES) {
        await this.stream.writeAll(
          encodeBrokerExchangeFrame({
            kind: 4,
            epoch: this.#epoch,
            request,
            payload: input.subarray(offset, offset + BROKER_EXCHANGE_CHUNK_BYTES),
          }),
        );
      }
      await this.stream.writeAll(
        encodeBrokerExchangeFrame({
          kind: 5,
          epoch: this.#epoch,
          request,
          payload: new Uint8Array(),
        }),
      );
    };
    const read = async (): Promise<BrokerCompletion> => {
      for (;;) {
        const frame = await readBrokerExchangeFrame(this.stream);
        if (
          frame.request !== request ||
          !frame.epoch.every((byte, index) => byte === this.#epoch[index])
        )
          throw new Error('native broker exchange identity mismatch');
        if (frame.kind === 6) return decodeBrokerCompletion(frame.payload);
        if (frame.kind !== 4)
          throw new Error(`unexpected native broker exchange record ${frame.kind}`);
        if (callbackFailure === undefined) {
          try {
            onChunk(frame.payload);
          } catch (error) {
            // Continue reading and writing. Only the terminal proves callback recovery.
            callbackFailure = { error };
          }
        }
      }
    };
    const writing = write();
    const reading = read();
    let completion: BrokerCompletion;
    try {
      [, completion] = await Promise.all([writing, reading]);
    } catch (error) {
      // Break the opposite direction's backpressure before awaiting settlement.
      let closeFailure: { error: unknown } | undefined;
      try {
        await this.close();
      } catch (failure) {
        closeFailure = { error: failure };
      }
      await Promise.allSettled([writing, reading]);
      if (closeFailure !== undefined)
        throw new AggregateError(
          [error, closeFailure.error],
          'native broker exchange and close failed',
        );
      throw error;
    } finally {
      this.#activeRequest = undefined;
    }
    if (completion.reason !== 'success') {
      if (completion.requiresReopen) this.#closed = true;
      throw new BrokerExchangeError(completion);
    }
    if (callbackFailure !== undefined) throw callbackFailure.error;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.stream.close();
  }
}

/** Validate complete frontend frames without predicting PostgreSQL readiness. */
function validateInput(input: Uint8Array): void {
  if (input.length === 0 || input.length > 128 * 1024 * 1024)
    throw new Error('invalid PostgreSQL request length');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (let offset = 0; offset < input.length; ) {
    if (input.length - offset < 5) throw new Error('truncated PostgreSQL frontend header');
    const length = view.getInt32(offset + 1);
    if (length < 4 || length + 1 > input.length - offset)
      throw new Error('invalid PostgreSQL frontend frame length');
    if (input[offset] === 0 || input[offset] === 0x58 || input[offset] === 0x70)
      throw new Error('PostgreSQL connection control is not an exchange request');
    offset += length + 1;
  }
}
