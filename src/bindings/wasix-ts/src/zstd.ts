import { decompress as decompressWithFzstd } from 'fzstd';

export type ZstdDecompressor = (bytes: Uint8Array) => Uint8Array;

let hostZstdDecompressor: ZstdDecompressor | undefined;

/** @internal Installed by a host realm when it has a native implementation. */
export function installZstdDecompressor(decompressor: ZstdDecompressor): void {
  if (hostZstdDecompressor !== undefined) {
    throw new Error('Oliphaunt WASIX zstd decompressor is already installed');
  }
  hostZstdDecompressor = decompressor;
}

export function decompressZstd(bytes: Uint8Array): Uint8Array {
  return (hostZstdDecompressor ?? decompressWithFzstd)(bytes);
}
