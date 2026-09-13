import { readWasixByteChannelSync, type WasixByteChannel } from '../byte-channel.js';

// The fake worker and its producer share the test thread. Wait for data or EOF
// before calling the blocking reader used by real dedicated workers.
export async function readWasixByteChannel(channel: WasixByteChannel): Promise<Uint8Array> {
  const control = new Int32Array(channel.control);
  while (Atomics.load(control, 0) === Atomics.load(control, 1) && Atomics.load(control, 2) === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  return readWasixByteChannelSync(channel);
}
