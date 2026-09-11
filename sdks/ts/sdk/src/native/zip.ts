export type ZipFile = {
  path: string;
  bytes: Uint8Array;
  mode: number;
};

export type ZipExtractionHost = {
  join(root: string, path: string): string;
  dirname(path: string): string;
  mkdir(path: string): Promise<void>;
  writeFile(file: ZipFile): Promise<void>;
};

export async function extractZipArchive(
  bytes: Uint8Array,
  root: string,
  host: ZipExtractionHost,
  inflateRaw: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<void> {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entries = readUInt16LE(bytes, eocdOffset + 10);
  const centralDirectorySize = readUInt32LE(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32LE(bytes, eocdOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw new Error('ZIP central directory is outside archive bounds');
  }

  let offset = centralDirectoryOffset;
  for (let index = 0; index < entries; index += 1) {
    requireSignature(bytes, offset, 0x02014b50, 'central directory header');
    const method = readUInt16LE(bytes, offset + 10);
    const compressedSize = readUInt32LE(bytes, offset + 20);
    const uncompressedSize = readUInt32LE(bytes, offset + 24);
    const nameLength = readUInt16LE(bytes, offset + 28);
    const extraLength = readUInt16LE(bytes, offset + 30);
    const commentLength = readUInt16LE(bytes, offset + 32);
    const externalAttributes = readUInt32LE(bytes, offset + 38);
    const localOffset = readUInt32LE(bytes, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw new Error('ZIP entry name is outside archive bounds');
    }
    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameEnd));
    const mode = (externalAttributes >>> 16) & 0o777 || 0o644;
    offset = nameEnd + extraLength + commentLength;

    const safePath = validateZipPath(path);
    if (safePath === undefined || safePath === '.') {
      continue;
    }
    if (safePath.endsWith('/')) {
      await host.mkdir(host.join(root, safePath.slice(0, -1)));
      continue;
    }

    requireSignature(bytes, localOffset, 0x04034b50, 'local file header');
    const localNameLength = readUInt16LE(bytes, localOffset + 26);
    const localExtraLength = readUInt16LE(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new Error(`ZIP entry ${safePath} data is outside archive bounds`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    const content =
      method === 0 ? compressed : method === 8 ? await inflateRaw(compressed) : undefined;
    if (content === undefined) {
      throw new Error(`ZIP entry ${safePath} uses unsupported compression method ${method}`);
    }
    if (content.length !== uncompressedSize) {
      throw new Error(`ZIP entry ${safePath} has invalid uncompressed size`);
    }
    const output = host.join(root, safePath);
    await host.mkdir(host.dirname(output));
    await host.writeFile({ path: output, bytes: content, mode });
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUInt32LE(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('ZIP end of central directory was not found');
}

function validateZipPath(path: string): string | undefined {
  if (path.length === 0 || path.includes('\0') || path.startsWith('/') || path.includes('\\')) {
    throw new Error(`unsafe ZIP entry path: ${path}`);
  }
  const parts: string[] = [];
  for (const rawPart of path.split('/')) {
    if (rawPart.length === 0 || rawPart === '.') {
      continue;
    }
    if (rawPart === '..') {
      throw new Error(`unsafe ZIP entry path: ${path}`);
    }
    parts.push(rawPart);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `${parts.join('/')}${path.endsWith('/') ? '/' : ''}`;
}

function requireSignature(
  bytes: Uint8Array,
  offset: number,
  signature: number,
  label: string,
): void {
  if (offset < 0 || offset + 4 > bytes.length || readUInt32LE(bytes, offset) !== signature) {
    throw new Error(`invalid ZIP ${label}`);
  }
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error('truncated ZIP archive');
  }
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error('truncated ZIP archive');
  }
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
