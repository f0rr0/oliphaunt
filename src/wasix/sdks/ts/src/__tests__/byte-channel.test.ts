import { describe, expect, it } from 'bun:test';
import {
  closeWasixByteChannel,
  createWasixByteChannel,
  failWasixByteChannel,
  markWasixByteChannelProtocolComplete,
  markWasixByteChannelProtocolStarted,
  readWasixByteChannel,
  readWasixByteChannelSync,
  wasixByteChannelProtocolOutcomeUnknown,
  wasixByteChannelProtocolStarted,
  writeWasixByteChannel,
  writeWasixByteChannelSync,
} from '../protocol/byte-channel.js';

describe('bounded WASIX byte channel', () => {
  it('does not return destination credit before the owned chunk is accepted', async () => {
    const channel = createWasixByteChannel();
    let produced = false;
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const producing = writeWasixByteChannel(channel, new Uint8Array(channel.data.byteLength)).then(
      () => {
        produced = true;
      },
    );
    const consuming = readWasixByteChannel(channel, 64 * 1024, async () => {
      entered();
      await hold;
    });
    await writing;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(produced).toBe(false);
    release();
    await consuming;
    await producing;
    expect(produced).toBe(true);
    closeWasixByteChannel(channel);
  });
  it('preserves byte order across synchronous and asynchronous endpoints', async () => {
    const channel = createWasixByteChannel();
    writeWasixByteChannelSync(channel, Uint8Array.of(1, 2, 3));
    expect(await readWasixByteChannel(channel, 2)).toEqual(Uint8Array.of(1, 2));
    await writeWasixByteChannel(channel, Uint8Array.of(4, 5));
    expect(readWasixByteChannelSync(channel)).toEqual(Uint8Array.of(3, 4, 5));
  });

  it('reports EOF only after buffered bytes have been consumed', async () => {
    const channel = createWasixByteChannel();
    await writeWasixByteChannel(channel, Uint8Array.of(7));
    closeWasixByteChannel(channel);
    expect(readWasixByteChannelSync(channel)).toEqual(Uint8Array.of(7));
    await expect(readWasixByteChannel(channel)).resolves.toEqual(new Uint8Array());
  });

  it('fails readers and writers after transport failure', async () => {
    const channel = createWasixByteChannel();
    failWasixByteChannel(channel);
    expect(() => readWasixByteChannelSync(channel)).toThrow(/channel failed/);
    await expect(writeWasixByteChannel(channel, Uint8Array.of(1))).rejects.toThrow(
      /channel failed/,
    );
  });

  it('shares tool protocol activity without changing channel flow', () => {
    const channel = createWasixByteChannel();
    expect(wasixByteChannelProtocolStarted(channel)).toBe(false);
    expect(wasixByteChannelProtocolOutcomeUnknown(channel)).toBe(false);
    markWasixByteChannelProtocolStarted(channel);
    expect(wasixByteChannelProtocolStarted(channel)).toBe(true);
    expect(wasixByteChannelProtocolOutcomeUnknown(channel)).toBe(true);
    markWasixByteChannelProtocolComplete(channel);
    expect(wasixByteChannelProtocolStarted(channel)).toBe(true);
    expect(wasixByteChannelProtocolOutcomeUnknown(channel)).toBe(false);
  });
});

type WaitAsync = (
  array: Int32Array,
  index: number,
  value: number,
  timeout?: number,
) => { async: false; value: string } | { async: true; value: Promise<string> };
const asyncAtomics = Atomics as typeof Atomics & { waitAsync: WaitAsync };

it('does not lose terminal transitions between checking state and waiting', async () => {
  for (const asynchronous of [false, true]) {
    for (const writer of [false, true]) {
      for (const failure of [false, true]) {
        const channel = createWasixByteChannel();
        if (writer) writeWasixByteChannelSync(channel, new Uint8Array(channel.data.byteLength - 1));
        const originalWait = Atomics.wait;
        const originalWaitAsync = asyncAtomics.waitAsync;
        let waitResult: string | undefined;
        let injected = false;
        const inject = () => {
          if (injected) return;
          injected = true;
          if (failure) failWasixByteChannel(channel);
          else closeWasixByteChannel(channel);
        };
        Atomics.wait = ((array: Int32Array, index: number, value: number) => {
          inject();
          waitResult = originalWait(array, index, value, 15);
          return waitResult;
        }) as typeof Atomics.wait;
        asyncAtomics.waitAsync = ((array, index, value) => {
          inject();
          const result = originalWaitAsync(array, index, value, 15);
          if (result.async)
            return {
              async: true,
              value: result.value.then((value) => {
                waitResult = value;
                return value;
              }),
            };
          waitResult = result.value;
          return result;
        }) as typeof asyncAtomics.waitAsync;
        let outcome = 'EOF';
        try {
          if (writer) {
            if (asynchronous) await writeWasixByteChannel(channel, Uint8Array.of(1));
            else writeWasixByteChannelSync(channel, Uint8Array.of(1));
          } else {
            const data = asynchronous
              ? await readWasixByteChannel(channel)
              : readWasixByteChannelSync(channel);
            expect(data.length).toBe(0);
          }
        } catch (error) {
          outcome = (error as Error).message;
        } finally {
          Atomics.wait = originalWait;
          asyncAtomics.waitAsync = originalWaitAsync;
        }
        expect(injected).toBe(true);
        expect(waitResult).toBe('not-equal');
        expect(outcome).toBe(
          failure
            ? 'Oliphaunt WASIX byte channel failed'
            : writer
              ? 'Oliphaunt WASIX byte channel is closed'
              : 'EOF',
        );
      }
    }
  }
});
