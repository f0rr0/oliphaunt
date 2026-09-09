export type ByteStream = {
  readExactly(length: number): Promise<Uint8Array>;
  writeAll(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
};
