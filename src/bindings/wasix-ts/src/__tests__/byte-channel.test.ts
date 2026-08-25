import { describe, expect, it } from 'vitest';
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
} from '../byte-channel.js';

describe('bounded WASIX byte channel', () => {
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
