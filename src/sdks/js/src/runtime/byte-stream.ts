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
