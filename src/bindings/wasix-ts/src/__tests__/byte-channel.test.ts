import { describe, expect, it } from 'vitest';
import {
  closeWasixByteChannel,
  createWasixByteChannel,
  failWasixByteChannel,
  markWasixByteChannelProtocolComplete,
  markWasixByteChannelProtocolStarted,
  readWasixByteChannelSync,
  wasixByteChannelProtocolOutcomeUnknown,
  writeWasixByteChannelSync,
} from '../byte-channel.js';

describe('bounded WASIX byte channel', () => {
  it('preserves byte order across dedicated worker endpoints', () => {
    const channel = createWasixByteChannel();
    writeWasixByteChannelSync(channel, Uint8Array.of(1, 2, 3));
    expect(readWasixByteChannelSync(channel, 2)).toEqual(Uint8Array.of(1, 2));
    writeWasixByteChannelSync(channel, Uint8Array.of(4, 5));
    expect(readWasixByteChannelSync(channel)).toEqual(Uint8Array.of(3, 4, 5));
  });

  it('reports EOF only after buffered bytes have been consumed', () => {
    const channel = createWasixByteChannel();
    writeWasixByteChannelSync(channel, Uint8Array.of(7));
    closeWasixByteChannel(channel);
    expect(readWasixByteChannelSync(channel)).toEqual(Uint8Array.of(7));
    expect(readWasixByteChannelSync(channel)).toEqual(new Uint8Array());
  });

  it('fails readers and writers after transport failure', () => {
    const channel = createWasixByteChannel();
    failWasixByteChannel(channel);
    expect(() => readWasixByteChannelSync(channel)).toThrow(/channel failed/);
    expect(() => writeWasixByteChannelSync(channel, Uint8Array.of(1))).toThrow(/channel failed/);
  });

  it('shares tool protocol activity without changing channel flow', () => {
    const channel = createWasixByteChannel();
    expect(wasixByteChannelProtocolOutcomeUnknown(channel)).toBe(false);
    markWasixByteChannelProtocolStarted(channel);
    expect(wasixByteChannelProtocolOutcomeUnknown(channel)).toBe(true);
    markWasixByteChannelProtocolComplete(channel);
    expect(wasixByteChannelProtocolOutcomeUnknown(channel)).toBe(false);
  });
});
